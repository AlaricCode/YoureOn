// The projector's voice against the real server (DB-backed: skipped without DATABASE_URL): a
// ruling goes out, the stage gets its stage.voice frame, fetches the ElevenLabs clip with its
// bearer and plays it, and the browser stays silent. With the server's TTS off (no key) no frame
// comes, and the browser speaks the same line after the wait. In a bet the voice judge hosts
// (A's phone relayed its judge.line transcript) neither speaks: the phone judge says the ruling.
// ElevenLabs is a fake fetch.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiSessions,
  bets,
  createDb,
  rooms,
  runMigrations,
  users,
  type DbHandle,
} from '@youre-on/db';
import {
  ClipCache,
  createDeps,
  createElevenLabsClient,
  DEFAULT_STAGE_VOICES,
  emitBetEvent,
  loadEnv,
  routeModules,
  silentLogger,
  startServer,
  StageTts,
  type RunningServer,
} from '@youre-on/server';
import {
  fetchAudio,
  fetchBetSnapshot,
  fetchStageAudio,
  StageConnection,
  type WsLike,
} from '../src/connection';
import { applyFrame, initialTicker, type TickerState } from '../src/ticker';
import { freshVoiceLines, StageVoice, VOICE_WAIT_MS, type Playable } from '../src/voice';

const rulingExample = (): Record<string, unknown> =>
  (
    JSON.parse(
      readFileSync(
        new URL('../../../packages/shared/test/vectors/ruling-v1-001.json', import.meta.url),
        'utf8',
      ),
    ) as { input: Record<string, unknown> }
  ).input;
const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 7, 7, 7, 7]);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomPubkey(): string {
  let n = BigInt(`0x${randomBytes(32).toString('hex')}`);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)]! + s;
    n /= 58n;
  }
  return s;
}

async function serverWith(db: DbHandle, tts: StageTts | null): Promise<RunningServer> {
  const { deps } = createDeps({
    env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: DB_URL }),
    dbHandle: db,
    rateLimit: false,
    stageTts: tts,
  });
  return startServer(deps, { port: 0, hostname: '127.0.0.1', modules: routeModules });
}

d('the projector voice against the server (DB)', () => {
  let db: DbHandle;
  let voiced: RunningServer;
  let silent: RunningServer;
  const elCalls: string[] = [];

  beforeAll(async () => {
    await runMigrations(DB_URL!);
    db = createDb({ url: DB_URL!, max: 4 });
    const tts = new StageTts({
      client: createElevenLabsClient({
        apiKey: 'k',
        fetch: async (url) => {
          elCalls.push(url);
          return new Response(MP3);
        },
      }),
      model: 'eleven_v4_turbo',
      voices: { ...DEFAULT_STAGE_VOICES },
      cache: new ClipCache({ dir: null }),
      log: silentLogger,
    });
    voiced = await serverWith(db, tts);
    silent = await serverWith(db, null);
  });
  afterAll(async () => {
    await voiced?.close();
    await silent?.close();
    await db?.close();
  });

  /** A room, a bet between Logan and Jake in it, and a stage token for the room. */
  async function betInRoom() {
    const code = Array.from(randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(
      '',
    );
    const [room] = await db.db
      .insert(rooms)
      .values({ code, name: 'voice test' })
      .returning({ id: rooms.id });
    const [a, b] = await db.db
      .insert(users)
      .values(
        ['Logan', 'Jake'].map((display_name) => ({
          display_name,
          wallet_pubkey: randomPubkey(),
          age_attested_18plus: true,
          attested_at: new Date(),
        })),
      )
      .returning({ id: users.id });
    const [bet] = await db.db
      .insert(bets)
      .values({
        room_id: room!.id,
        party_a_id: a!.id,
        party_b_id: b!.id,
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      })
      .returning({ id: bets.id });
    const token = `yo_s_${randomBytes(32).toString('base64url')}`;
    await db.db.insert(apiSessions).values({
      token_sha256: createHash('sha256').update(token).digest('hex'),
      scopes: ['stage'],
      room_id: room!.id,
    });
    return { roomId: room!.id, betId: bet!.id, token };
  }

  /** The stage's ticker on the server's socket, seeded with the bet's snapshot (its names). */
  async function stageOn(server: RunningServer) {
    const s = await betInRoom();
    const base = `http://127.0.0.1:${server.port}`;
    let state: TickerState = initialTicker;
    const conn = new StageConnection({
      wsUrl: `ws://127.0.0.1:${server.port}/v1/ws`,
      token: s.token,
      roomId: s.roomId,
      onAction: (a) => (state = applyFrame(state, a)),
      makeSocket: (u) => new WebSocket(u) as unknown as WsLike,
    });
    conn.start();
    await expect.poll(() => server.deps.hub.hasStage(s.roomId), { timeout: 3000 }).toBe(true);
    conn.subscribe(s.betId, 0);
    const snap = await fetchBetSnapshot(base, s.token, s.betId);
    state = applyFrame(state, { kind: 'snapshot', bet: snap, receivedAt: Date.now() });
    return { ...s, base, conn, get: () => state };
  }

  /** StageVoice over the real clip route, recording what was played and what was spoken. */
  function voiceFor(base: string, token: string) {
    const out = { played: [] as number[], spoken: [] as string[], loaded: [] as string[] };
    const v = new StageVoice({
      load: async (url): Promise<Playable> => {
        const raw = await fetchAudio(base, token, url);
        out.loaded.push(url);
        return { play: async () => void out.played.push(raw.byteLength) };
      },
      speak: async (l) => void out.spoken.push(l.text),
      on: () => true,
    });
    return { v, out };
  }

  it('ElevenLabs on: the stage.voice clip plays; the browser stays silent', async () => {
    const s = await stageOn(voiced);
    await emitBetEvent(voiced.deps, {
      bet_id: s.betId,
      type: 'ruling.issued',
      payload: { ruling: { ...rulingExample(), bet_id: s.betId }, ruling_hash: 'e'.repeat(64) },
    } as never);
    await expect.poll(() => s.get().voiceClips.length, { timeout: 3000 }).toBe(1);
    const clip = s.get().voiceClips[0]!;
    // the stage composes the same words the server voiced (its fallback would say them too)
    const lines = freshVoiceLines(s.get(), s.betId, new Set(), Date.now());
    expect(lines).toEqual([{ key: clip.key, voice: 'judge', text: clip.text }]);
    expect(clip.text).toMatch(/^Jake wins\. /);
    expect(await fetchStageAudio(s.base, s.token)).toMatchObject({ tts: true, tts_off: null });

    const { v, out } = voiceFor(s.base, s.token);
    v.expect(lines[0]!);
    v.clip(clip);
    await expect.poll(() => out.played, { timeout: 3000 }).toEqual([MP3.length]);
    await new Promise((r) => setTimeout(r, VOICE_WAIT_MS + 200));
    expect(out.spoken).toEqual([]);
    expect(
      elCalls.some((u) => u.includes(`/v1/text-to-speech/${DEFAULT_STAGE_VOICES.judge}`)),
    ).toBe(true);
    s.conn.stop();
  });

  it('a bet the voice judge hosts: no frame, no clip, and the browser stays silent too', async () => {
    for (const server of [voiced, silent]) {
      const s = await stageOn(server);
      await emitBetEvent(server.deps, {
        bet_id: s.betId,
        type: 'judge.line',
        payload: { utterance_id: randomUUID(), text: 'Logan, what counts as a flip?', final: true },
      } as never);
      // the judge talks in Beat 2, long before the ruling: the stage has the line by then
      await expect
        .poll(() => s.get().history[s.betId]?.some((e) => e.type === 'judge.line'), {
          timeout: 3000,
        })
        .toBe(true);
      const before = elCalls.length;
      await emitBetEvent(server.deps, {
        bet_id: s.betId,
        type: 'ruling.issued',
        payload: {
          ruling: { ...rulingExample(), bet_id: s.betId, reason: 'The phone judge has it.' },
          ruling_hash: '9'.repeat(64),
        },
      } as never);
      await expect
        .poll(() => s.get().history[s.betId]?.some((e) => e.type === 'ruling.issued'), {
          timeout: 3000,
        })
        .toBe(true);
      const lines = freshVoiceLines(s.get(), s.betId, new Set(), Date.now());
      expect(lines).toEqual([
        expect.objectContaining({ text: 'Jake wins. The phone judge has it.', phone: true }),
      ]);
      const { v, out } = voiceFor(s.base, s.token);
      v.expect(lines[0]!);
      await server.deps.stageVoice!.idle();
      await new Promise((r) => setTimeout(r, VOICE_WAIT_MS + 200));
      expect(out.spoken).toEqual([]);
      expect(out.loaded).toEqual([]);
      expect(s.get().voiceClips).toEqual([]);
      expect(elCalls.length).toBe(before);
      s.conn.stop();
    }
  });

  it('ElevenLabs off (no key): no frame comes, so the browser speaks the line after the wait', async () => {
    const s = await stageOn(silent);
    await emitBetEvent(silent.deps, {
      bet_id: s.betId,
      type: 'ruling.issued',
      payload: {
        ruling: { ...rulingExample(), bet_id: s.betId, outcome: 'A_WINS' },
        ruling_hash: 'f'.repeat(64),
      },
    } as never);
    await expect
      .poll(() => s.get().history[s.betId]?.some((e) => e.type === 'ruling.issued'), {
        timeout: 3000,
      })
      .toBe(true);
    expect(await fetchStageAudio(s.base, s.token)).toEqual({
      tts: false,
      tts_off: 'no_key',
      model: null,
      sfx: null,
    });
    const [line] = freshVoiceLines(s.get(), s.betId, new Set(), Date.now());
    const { v, out } = voiceFor(s.base, s.token);
    v.expect(line!);
    await new Promise((r) => setTimeout(r, VOICE_WAIT_MS / 2));
    expect(out.spoken).toEqual([]);
    await expect.poll(() => out.spoken, { timeout: 3000 }).toEqual([line!.text]);
    expect(line!.text).toMatch(/^Logan wins\. /);
    expect(s.get().voiceClips).toEqual([]);
    expect(out.loaded).toEqual([]);
    s.conn.stop();
  });
});
