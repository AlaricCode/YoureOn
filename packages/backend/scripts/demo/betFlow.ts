/**
 * The app-side steps of one bet (§12.10 screens), as the phones perform them
 * over HTTP/WS: dictate → Terms (accept by voice + wallet signature) →
 * create → Scene check (WS frames, detect, calibration, practice) → Stake →
 * Record (witnesses, start beacon, hash-chained chunks, End) → Ruling.
 */
import { acceptSigMessage, chainGenesis, chunkHash, chunkSigMessage, sha256, type Program } from '@verdict/engine';
import { generateKeypair, type KeyPair } from '../../src/crypto/keys.js';
import { toHex } from '../../src/util/bytes.js';
import type { AppClient, SignPayload } from './client.js';
import { waitFor, type Harness } from './harness.js';
import { frameJpeg, micChunk, mjpegChunk, speechWav } from './media.js';
import type { Crew } from './setup.js';
import { usd, type Transcript } from './transcript.js';

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const CHUNK_MS = 5000;

export interface Draft {
  draft_id: string;
  status: string;
  kind: string;
  title: string | null;
  program: Program;
  program_hash: string;
  readback: string[];
  labels: Record<string, string>;
  questions: { id: string; kind: string; text: string }[];
  participants: { display_name: string; accepted: boolean }[];
}

export interface BetView {
  id: string;
  title: string;
  kind: string;
  state: string;
  state_label: string;
  program: Program;
  labels: Record<string, string>;
  participants: { display_name: string; funded: boolean; consent: string; accepted: boolean }[];
  conditions: { leg: number; field: string; path: string; label: string }[];
  witnesses: { label: string; synced: boolean | null }[];
  preruling: { code: number; reason: number; winner_mask: number } | null;
  dispute: { reason: number; bond_units: number } | null;
  booth_status: string | null;
  settlement: { path: string; winner_mask: number; payouts: { user_id: string; amount_units: number }[] } | null;
  pot_units: number;
}

// ---- Terms ---------------------------------------------------------------------------

/** The creator dictates (WAV upload; mock STT hears `spoken`), answering blocking questions with `answers`. */
export async function dictate(crew: Crew, spoken: string, t: Transcript, answers: Record<string, string> = {}): Promise<Draft> {
  const { alice } = crew;
  let d = await alice.post<Draft>(
    '/bets/compile',
    { huddle_id: crew.huddleId, audio_b64: b64(speechWav(2500)) },
    { 'x-mock-transcript': spoken },
  );
  t.step(alice.name, `dictates "${spoken}" → ${d.status}${d.title ? ` "${d.title}"` : ''} (${d.kind})`);
  for (let i = 0; i < 3 && d.status === 'needs_clarification'; i++) {
    const blocking = d.questions.filter((q) => q.kind !== 'region');
    const ans = blocking.map((q) => ({ question_id: q.id, answer: answers[q.id] ?? '' })).filter((a) => a.answer);
    if (ans.length === 0) break;
    d = await alice.post<Draft>('/bets/compile', { huddle_id: crew.huddleId, draft_id: d.draft_id, answers: ans });
    t.step(alice.name, `answers ${ans.map((a) => `${a.question_id}=${a.answer}`).join(', ')} → ${d.status}`);
  }
  t.check(`draft "${d.title}" ready`, d.status === 'ready', d.status);
  for (const line of d.readback) t.step('', `  read-back: ${line}`);
  return d;
}

/** Bob listens to the read-back, then says "I accept <w1> <w2>" and signs accept_sig with the wallet. */
export async function accept(crew: Crew, d: Draft, t: Transcript): Promise<void> {
  const { bob } = crew;
  const audio = await bob.bytes(`/drafts/${d.draft_id}/readback.mp3`);
  const ch = await bob.get<{ challenge_id: string; phrase: string }>(`/drafts/${d.draft_id}/accept/challenge`);
  const wav = speechWav(1800);
  const sig = bob.wallet.sign(acceptSigMessage(d.program_hash, wav));
  const r = await bob.post<{ accepted: boolean; cos_bps: number; participant_index: number }>(
    `/drafts/${d.draft_id}/accept`,
    { challenge_id: ch.challenge_id, audio_b64: b64(wav), accept_sig_b64: b64(sig) },
    { 'x-mock-transcript': ch.phrase },
  );
  t.check('Bob accepted', r.accepted);
  t.step(bob.name, `heard read-back (${audio.bytes.length} B ${audio.type}); says "${ch.phrase}" → accepted (voice cos ${r.cos_bps} bps), accept_sig signed`);
}

/** The creator's Continue: POST /bets → sign create_bet (backend adds fee payer + oracle). */
export async function createBet(crew: Crew, d: Draft, t: Transcript): Promise<BetView> {
  const { alice } = crew;
  const r = await alice.post<{ bet: BetView; sign: SignPayload }>('/bets', { draft_id: d.draft_id });
  await alice.signConfirmed(r.sign, 'create_bet');
  const bet = await alice.get<BetView>(`/bets/${r.bet.id}`);
  t.check('bet created (proposed)', bet.state === 'proposed', bet.state);
  t.step(alice.name, `POST /bets → "${r.sign.summary}" signed → bet ${bet.id.slice(0, 8)}… ${bet.state_label}`);
  return bet;
}

/** Subscribes to `bet:<id>` and waits for the snapshot (the subscription is live once it arrives). */
async function watchBet(c: AppClient, betId: string): Promise<void> {
  await c.connectWs([`bet:${betId}`]);
  await c.nextWs((m) => (m.type === 'bet' && (m['bet'] as { id?: string })?.id === betId) || m.type === 'error');
}

// ---- Scene check -----------------------------------------------------------------------

type Point = [number, number];

type Box = [number, number, number, number];

/**
 * How the demo camera operator frames the shot (§15 worked-example layouts):
 * the creator confirms these entity boxes in Scene check. The mock detector
 * otherwise returns a random layout per bet, which can be physically
 * meaningless (e.g. the can overlapping the shooter).
 */
const FRAMED_SHOT: Record<string, Box> = {
  shooter: [500, 1500, 2500, 9800],
  ball: [1200, 7000, 1500, 7500],
  can: [7600, 6200, 8800, 9400],
  tower: [4000, 3000, 5500, 9000],
  fan: [7000, 5000, 9000, 9000],
  me: [2000, 6000, 8000, 9000],
};
const cx = (b: Box) => (b[0] + b[2]) / 2;

/**
 * Where the creator drags a region in the Scene check (the app's default
 * placement): a line goes vertically halfway between the person and the
 * object farthest from them, with the person's side "behind"; a zone covers
 * the right-hand floor area.
 */
function placeRegion(p: Program, shape: string, entity: string, boxes: Map<string, Box>) {
  if (shape !== 'line') return { entity, shape: 'zone', points: [[6000, 5000], [9500, 5000], [9500, 9800], [6000, 9800]] as Point[] };
  const person = p.entities.find((e) => e.kind === 'person' || e.kind === 'person_any');
  const actor = person ? boxes.get(person.name) : undefined;
  const others = p.entities.filter((e) => e.kind === 'object').map((e) => boxes.get(e.name)).filter((b): b is Box => !!b);
  if (!actor || others.length === 0) return { entity, shape: 'line', points: [[3000, 6000], [3000, 10000]] as Point[], behind_sign: 1 };
  const target = others.sort((a, b) => Math.abs(cx(b) - cx(actor)) - Math.abs(cx(a) - cx(actor)))[0]!;
  const x = Math.round((cx(actor) + cx(target)) / 2);
  // side(a, b, p) for a=(x,6000) → b=(x,10000) is +1 for points left of the line.
  return { entity, shape: 'line', points: [[x, 6000], [x, 10000]] as Point[], behind_sign: cx(actor) < x ? 1 : -1 };
}

export async function sceneCheck(h: Harness, crew: Crew, bet: BetView, t: Transcript): Promise<void> {
  const { alice, bob } = crew;
  const p = bet.program;
  if (p.kind !== 'rules') return;
  // Live WS scene stream (10 fps frames → `scene` rows).
  await watchBet(alice, bet.id);
  for (let i = 0; i < 5; i++) alice.wsSend({ type: 'scene.frame', bet_id: bet.id, jpeg_b64: b64(frameJpeg()), t_ms: i * 100 });
  const scene = await alice.nextWs((m) => m.type === 'scene' && m['bet_id'] === bet.id);
  const rows = (scene['conditions'] as { label: string; placed: boolean }[]) ?? [];
  t.step(alice.name, `scene stream → ${rows.map((r) => `${r.label}${r.placed ? '' : ' (unplaced)'}`).join(' · ')}`);
  // Single-frame detect for entity boxes.
  const det = await alice.post<{ entities: { entity: string; label: string; bbox: [number, number, number, number]; conf: number }[] }>(
    `/bets/${bet.id}/scene/detect`,
    { frame_b64: b64(frameJpeg()) },
  );
  t.step(alice.name, `detect → ${det.entities.map((e) => `${e.label} ${e.conf}%`).join(', ')}`);
  const refs = p.entities
    .filter((e) => e.kind !== 'region')
    .map((e) => {
      const d = det.entities.find((x) => x.entity === e.name);
      const label = (bet.labels[e.name] ?? d?.label ?? e.name).split(/\s+/).slice(0, 3).join(' ');
      return { entity: e.name, label, bbox: FRAMED_SHOT[e.name] ?? d?.bbox ?? ([1000, 1000, 3000, 3000] as Box) };
    });
  const boxes = new Map(refs.map((r) => [r.entity, r.bbox as Box]));
  const regions = p.entities.filter((e) => e.kind === 'region').map((e) => placeRegion(p, (e as { shape: string }).shape, e.name, boxes));
  // Bob's phone is read-only here.
  const code = await bob.expectError('PUT', `/bets/${bet.id}/calibration`, {});
  t.check('non-creator cannot calibrate', code === 'WRONG_STATE', code);
  const cal = await alice.put<{ calibration_hash: string }>(`/bets/${bet.id}/calibration`, {
    version: 1,
    scene: { camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' }, entity_refs: refs },
    regions,
  });
  t.step(alice.name, `places ${regions.map((r) => r.entity).join(', ') || 'no regions'} → calibration ${cal.calibration_hash.slice(0, 8)}…`);
  const practice = await alice.post<{ conditions: { label: string; fired: boolean; frame: number | null }[] }>(`/bets/${bet.id}/practice`, {
    frames_b64: Array.from({ length: 20 }, () => b64(frameJpeg())),
  });
  t.step(alice.name, `practice (20 frames) → ${practice.conditions.map((c) => `${c.label}:${c.fired ? `fired@${c.frame}` : 'no'}`).join(' · ')}`);
  void h;
}

export async function fundAll(crew: Crew, bet: BetView, t: Transcript): Promise<void> {
  for (const c of [crew.alice, crew.bob]) {
    const r = await c.post<{ sign: SignPayload }>(`/bets/${bet.id}/fund`);
    await c.signConfirmed(r.sign, 'fund');
    t.step(c.name, `Stake → "${r.sign.summary}" signed`);
  }
  if (bet.program.kind === 'rules') {
    const code = await crew.alice.expectError('PUT', `/bets/${bet.id}/calibration`, {});
    t.check('calibration locked after funding', code === 'CALIBRATION_LOCKED', code);
  }
}

// ---- Record ---------------------------------------------------------------------------

interface Witness {
  owner: AppClient;
  key: KeyPair;
  kind: 'camera' | 'audio';
  label: string;
  prev: Uint8Array;
  index: number;
  start: number;
}

async function postChunk(betId: string, w: Witness, body: Uint8Array, final: boolean): Promise<void> {
  const kind = w.kind === 'camera' ? 0 : 1;
  const bodySha = sha256(body);
  const c = chunkHash({ prev: w.prev, index: w.index, kind, start_ms: w.start, duration_ms: CHUNK_MS, body_sha256: bodySha });
  const rec = await w.owner.post<{ accepted: boolean; upload_url: string }>(`/bets/${betId}/chunks`, {
    witness_key: w.key.publicKey,
    index: w.index,
    kind: w.kind,
    body_format: w.kind === 'camera' ? 'mjpeg' : 'wav',
    ...(w.kind === 'camera' ? { width_px: 1920, height_px: 1080, orientation: 'landscape' } : {}),
    start_ms: w.start,
    duration_ms: CHUNK_MS,
    body_sha256: toHex(bodySha),
    chunk_hash: toHex(c),
    prev_hash: toHex(w.prev),
    sig_b64: b64(w.key.sign(chunkSigMessage(c))),
    final,
  });
  const path = new URL(rec.upload_url, 'http://x').pathname.replace(/^\/v1/, '');
  await w.owner.call('PUT', path, body);
  w.prev = c;
  w.index += 1;
  w.start += CHUNK_MS;
}

/**
 * Record screen: Alice's phone is the camera (+ its mic), Bob's phone a mic
 * witness. Start → WS `start` beacon; the camera phone plays it, both mics
 * hear it; each witness streams two 5 s hash-chained chunks; End.
 */
export async function record(h: Harness, crew: Crew, bet: BetView, t: Transcript): Promise<void> {
  const { alice, bob } = crew;
  const ws: Witness[] = [];
  const add = async (owner: AppClient, kind: 'camera' | 'audio') => {
    const key = generateKeypair();
    const r = await owner.post<{ witness_id: string; label: string }>(`/bets/${bet.id}/witnesses`, { witness_key: key.publicKey, kind });
    ws.push({ owner, key, kind, label: r.label, prev: new Uint8Array(32), index: 0, start: 0 });
  };
  await add(alice, 'camera');
  await add(alice, 'audio');
  await add(bob, 'audio');
  t.step('phones', `witnesses ${ws.map((w) => `${w.label}(${w.owner.name})`).join(', ')}`);

  await watchBet(alice, bet.id);
  await alice.post(`/bets/${bet.id}/start`);
  const start = await alice.nextWs((m) => m.type === 'start' && m['bet_id'] === bet.id);
  const beacon = start['beacon'] as { slot: number; hash_hex: string; symbols: number[] };
  const wavUrl = new URL(String(start['wav_url']), 'http://x').pathname.replace(/^\/v1/, '');
  const beaconWav = (await alice.bytes(wavUrl)).bytes;
  t.step(alice.name, `Start → beacon slot ${beacon.slot} (${beacon.symbols.length} symbols, ${beaconWav.length} B WAV) played on ${start['play_on_user_id'] === alice.userId ? 'Alice' : 'other'}'s phone`);
  for (const w of ws) w.owner.wsSend({ type: 'recording', bet_id: bet.id, witness_key: w.key.publicKey });
  const hashBytes = Uint8Array.from(Buffer.from(beacon.hash_hex, 'hex'));
  for (const w of ws) {
    w.prev = chainGenesis({ bet: bet.id, witness_key: w.key.publicKey, kind: w.kind === 'camera' ? 0 : 1, beacon_slot: BigInt(beacon.slot), beacon_hash: hashBytes });
  }
  for (let i = 0; i < 2; i++) {
    for (const w of ws) {
      const body = w.kind === 'camera' ? mjpegChunk(w.start, CHUNK_MS) : micChunk(CHUNK_MS, i === 0 ? beaconWav : null);
      await postChunk(bet.id, w, body, i === 1);
    }
    h.clock.advance(CHUNK_MS);
  }
  t.step('phones', `uploaded ${ws.length}×2 chunks (sha256 chain, witness-signed)`);
  await alice.post(`/bets/${bet.id}/end`);
  const after = await alice.get<BetView>(`/bets/${bet.id}`);
  t.step(alice.name, `End → witnesses ${after.witnesses.map((w) => `${w.label}:${w.synced ? 'synced' : 'unsynced'}`).join(', ')}`);
  t.check('every witness synced by the beacon', after.witnesses.every((w) => w.synced === true));
}

// ---- Ruling ----------------------------------------------------------------------------

export async function waitState(h: Harness, c: AppClient, betId: string, states: string[], what: string): Promise<BetView> {
  let last: BetView | null = null;
  try {
    return await waitFor(h, what, async () => {
      last = await c.get<BetView>(`/bets/${betId}`);
      return states.includes(last.state) ? last : null;
    });
  } catch (e) {
    const l = last as BetView | null;
    throw new Error(`${(e as Error).message} (bet ${betId} stuck in ${l?.state ?? '?'}; witnesses ${JSON.stringify(l?.witnesses ?? [])})`);
  }
}

export interface Ruling {
  outcome_text: string;
  amount_units: number | null;
  can_respond: boolean;
  bond_units: number;
  legs: { id: number; result: number; decisive_frames: number[] }[];
  preruling: { code: number; reason: number } | null;
}

export async function showRuling(c: AppClient, betId: string, t: Transcript): Promise<Ruling> {
  const r = await c.get<Ruling>(`/bets/${betId}/ruling`);
  const legs = r.legs.map((l) => `leg ${l.id}=${['F', 'T', 'U'][l.result] ?? '-'}${l.decisive_frames.length ? ` @${l.decisive_frames.slice(0, 3).join(',')}` : ''}`).join(' ');
  t.step(c.name, `Ruling: "${r.outcome_text}"${r.amount_units === null ? '' : ` ${usd(r.amount_units, true)}`} [${legs}]${r.can_respond ? ' · Agree/Dispute' : ''}`);
  return r;
}

export async function showSettlement(h: Harness, crew: Crew, betId: string, t: Transcript): Promise<BetView> {
  const v = await waitState(h, crew.alice, betId, ['settled', 'refunded'], 'settlement');
  const names = new Map([
    [crew.alice.userId, crew.alice.name],
    [crew.bob.userId, crew.bob.name],
  ]);
  const pays = v.settlement?.payouts.map((p) => `${names.get(p.user_id) ?? '?'} ${usd(p.amount_units)}`).join(', ') ?? '';
  t.step('chain', `${v.state_label} via ${v.settlement?.path ?? '?'} → payouts ${pays} (pot ${usd(v.pot_units)})`);
  const announce = await crew.alice.bytes(`/bets/${betId}/announce.mp3`);
  t.step(crew.alice.name, `announce.mp3 (${announce.bytes.length} B ${announce.type})`);
  const receipt = await crew.alice.get<{ rows: { label: string; status: string; detail: unknown }[] }>(`/bets/${betId}/receipt`);
  t.step(crew.alice.name, `Receipt: ${receipt.rows.map((r) => `${r.label}=${r.status}`).join(' · ')}`);
  for (const r of receipt.rows.filter((x) => x.status === 'failed')) t.step('', `  ${r.label} detail: ${JSON.stringify(r.detail)}`);
  return v;
}
