/* eslint-disable @typescript-eslint/no-explicit-any -- webhook bodies and audit details are loosely typed JSON */
// POST /webhooks/elevenlabs, the post-call webhook (API-CONTRACT §4.6): the ElevenLabs-Signature
// scheme (no SDK installed: t=<ts>,v0=<hex HMAC-SHA256(secret, `${t}.${body}`)>), the route's
// gates (404 while ELEVENLABS_WEBHOOK_SECRET is unset, 401 for a missing / malformed / stale /
// bad signature: DB-less), then over Postgres: each event type, the transcript archived (JCS +
// sha256 on voice_sessions, charging / llm_usage kept, secrets redacted) and the dedupe on
// (conversation_id, type). Nothing here calls ElevenLabs.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, voiceSessions } from '@youre-on/db';
import { jcs } from '@youre-on/shared/jcs';
import { buildApp } from '../src/app';
import { createDeps } from '../src/server';
import { sha256Hex } from '../src/crypto';
import { routeModules } from '../src/routes';
import type { ElevenLabsClient } from '../src/voice/elevenlabs';
import { createVoiceRoutes } from '../src/voice/routes';
import {
  EL_WEBHOOK_ACTION_PREFIX,
  EL_WEBHOOK_BODY_LIMIT,
  EL_WEBHOOK_PATH,
  scrubForStorage,
  servedLlms,
} from '../src/voice/post-call';
import {
  checkElSignatureHeader,
  EL_SIGNATURE_TOLERANCE_S,
  elevenLabsSignatureHeader,
  parseElSignatureHeader,
  verifyElevenLabsSignature,
} from '../src/voice/webhook-signature';
import {
  describeDb,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  testEnv,
  type Ctx,
  type SignedUp,
} from './helpers';

const WEBHOOK_SECRET = `wsec_${randomUUID()}`;
const TOOL_SECRET = `tool-secret-${randomUUID()}`;
const AGENT = 'agent_webhook_test';
const enc = (s: string) => new TextEncoder().encode(s);
const nowS = () => Math.floor(Date.now() / 1000);

describe('ElevenLabs-Signature (the SDK constructEvent scheme, by hand)', () => {
  const NOW = 1_795_300_000_000;
  const body = enc('{"type":"post_call_transcription","data":{}}');

  it('matches an HMAC computed independently (openssl dgst -sha256 -hmac)', () => {
    // printf '%s' '1795300000.{"type":"post_call_transcription","data":{}}' |
    //   openssl dgst -sha256 -hmac 'wsec_independent_vector'
    const header =
      't=1795300000,v0=39bd110def080fcdb2b52654bfe0141ddaff55e58585b9a95d2fc3414c99dfd8';
    expect(elevenLabsSignatureHeader('wsec_independent_vector', body, 1_795_300_000)).toBe(header);
    expect(
      verifyElevenLabsSignature({
        secret: 'wsec_independent_vector',
        header,
        rawBody: body,
        nowMs: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it('good: own header, spaces and upper-case hex, a second (rotation) v0, an unknown scheme', () => {
    const h = elevenLabsSignatureHeader(WEBHOOK_SECRET, body, NOW / 1000);
    const v = (header: string) =>
      verifyElevenLabsSignature({ secret: WEBHOOK_SECRET, header, rawBody: body, nowMs: NOW });
    expect(v(h)).toEqual({ ok: true });
    const [t, v0] = h.split(',');
    expect(v(` ${t} , ${v0!.toUpperCase().replace('V0=', 'v0=')} `)).toEqual({ ok: true });
    expect(v(`${t},v0=${'0'.repeat(64)},${v0}`)).toEqual({ ok: true });
    expect(v(`${t},v1=whatever,${v0}`)).toEqual({ ok: true });
    expect(parseElSignatureHeader(h)).toEqual({ t: String(NOW / 1000), v0: [v0!.slice(3)] });
  });

  it('bad: another secret, a changed byte, a signature of another timestamp', () => {
    const h = elevenLabsSignatureHeader(WEBHOOK_SECRET, body, NOW / 1000);
    const v = (o: { secret?: string; header?: string; rawBody?: Uint8Array }) =>
      verifyElevenLabsSignature({
        secret: o.secret ?? WEBHOOK_SECRET,
        header: o.header ?? h,
        rawBody: o.rawBody ?? body,
        nowMs: NOW,
      });
    expect(v({ secret: 'another-secret-value' })).toEqual({ ok: false, reason: 'bad_signature' });
    const tampered = body.slice();
    tampered[3] = tampered[3]! ^ 1;
    expect(v({ rawBody: tampered })).toEqual({ ok: false, reason: 'bad_signature' });
    const v0 = h.split(',')[1]!;
    expect(v({ header: `t=${NOW / 1000 + 1},${v0}` })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(v({ secret: '' })).toEqual({ ok: false, reason: 'missing' });
  });

  it('stale: older than the SDK tolerance (30 min), or more than 5 min in the future', () => {
    const at = (tS: number, nowMs = NOW) =>
      verifyElevenLabsSignature({
        secret: WEBHOOK_SECRET,
        header: elevenLabsSignatureHeader(WEBHOOK_SECRET, body, tS),
        rawBody: body,
        nowMs,
      });
    expect(EL_SIGNATURE_TOLERANCE_S).toBe(30 * 60);
    expect(at(NOW / 1000 - 30 * 60)).toEqual({ ok: true });
    expect(at(NOW / 1000 - 30 * 60 - 1)).toEqual({ ok: false, reason: 'stale' });
    expect(at(NOW / 1000 + 5 * 60)).toEqual({ ok: true });
    expect(at(NOW / 1000 + 5 * 60 + 1)).toEqual({ ok: false, reason: 'stale' });
  });

  it('missing / malformed headers are refused before any HMAC', () => {
    expect(checkElSignatureHeader(undefined, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(checkElSignatureHeader('  ', NOW)).toEqual({ ok: false, reason: 'missing' });
    for (const h of [
      'v0=' + 'a'.repeat(64), // no t
      `t=${NOW / 1000}`, // no v0
      `t=${NOW / 1000},v0=abc`, // not 32 bytes of hex
      `t=soon,v0=${'a'.repeat(64)}`, // not a number
      'sha256=deadbeef',
    ])
      expect([h, checkElSignatureHeader(h, NOW)]).toEqual([h, { ok: false, reason: 'malformed' }]);
  });
});

describe('post-call helpers', () => {
  it('scrubForStorage: secrets and the tool-secret header redacted, NUL / lone surrogates made storable', () => {
    const r = scrubForStorage(
      {
        a: `Bearer ${TOOL_SECRET}`,
        headers: { 'x-yo-tool-secret': 'whatever', other: 'kept' },
        list: ['ok', 'nul\u0000here', 'lone\uD800x', 'pair \uD83D\uDE00'],
        short: 'abc',
        huge: JSON.parse('1e400') as number, // Infinity: JCS refuses it
      },
      [TOOL_SECRET, undefined, 'abc'], // a value under 8 chars is never looked for
    );
    expect(r.redactions).toBe(2);
    expect(r.value).toEqual({
      a: '[redacted]',
      headers: { 'x-yo-tool-secret': '[redacted]', other: 'kept' },
      list: ['ok', 'nul\uFFFDhere', 'lone\uFFFDx', 'pair \uD83D\uDE00'],
      short: 'abc',
      huge: null,
    });
    expect(() => jcs(r.value)).not.toThrow();
  });

  it('servedLlms: the model_usage keys under metadata (charging.llm_usage)', () => {
    expect(
      servedLlms({
        charging: {
          llm_usage: {
            irreversible_generation: { model_usage: { 'claude-haiku-5-5': { input: {} } } },
            initiated_generation: { model_usage: { 'gemini-2.5-flash': {} } },
          },
        },
      }),
    ).toEqual(['claude-haiku-5-5', 'gemini-2.5-flash']);
    expect(servedLlms(null)).toEqual([]);
    expect(servedLlms({ charging: { llm_usage: {} } })).toEqual([]);
  });
});

describe('POST /webhooks/elevenlabs gates (no DB: nothing past the signature touches it)', () => {
  // DATABASE_URL points nowhere: a handler that reached the DB would answer 503/500, not this.
  function app(env: Record<string, string>) {
    const { deps } = createDeps({
      env: testEnv({ DATABASE_URL: 'postgres://unused@127.0.0.1:1/none', ...env }),
      rateLimit: false,
    });
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    deps.log = log;
    return { a: buildApp(deps, [createVoiceRoutes()]), log };
  }
  const body = JSON.stringify({
    type: 'post_call_transcription',
    event_timestamp: nowS(),
    data: { agent_id: AGENT, conversation_id: 'conv_gate', transcript: [] },
  });
  const post = (a: ReturnType<typeof app>['a'], headers: Record<string, string>, b = body) =>
    a.request(EL_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: b,
    });
  const sig = (secret = WEBHOOK_SECRET, tS = nowS(), b = body) => ({
    'ElevenLabs-Signature': elevenLabsSignatureHeader(secret, b, tS),
  });

  it('ELEVENLABS_WEBHOOK_SECRET unset: 404 for signed and unsigned data alike, and a log line', async () => {
    const { a, log } = app({});
    expect((await post(a, {})).status).toBe(404);
    expect((await post(a, sig())).status).toBe(404);
    expect((await post(a, sig('', nowS()))).status).toBe(404);
    expect(log.error).toHaveBeenCalledWith('voice.webhook_unconfigured', expect.anything());
  });

  it('secret set: 401 SIGNATURE_INVALID for missing, malformed, stale and bad signatures', async () => {
    const { a, log } = app({ ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const reasonOf = async (headers: Record<string, string>, b?: string) => {
      const r = await post(a, headers, b);
      const j = (await r.json()) as any;
      return [r.status, j.error.code, j.error.details.reason];
    };
    expect(await reasonOf({})).toEqual([401, 'SIGNATURE_INVALID', 'missing']);
    expect(await reasonOf({ 'ElevenLabs-Signature': 'v0=nope' })).toEqual([
      401,
      'SIGNATURE_INVALID',
      'malformed',
    ]);
    expect(await reasonOf(sig(WEBHOOK_SECRET, nowS() - 31 * 60))).toEqual([
      401,
      'SIGNATURE_INVALID',
      'stale',
    ]);
    expect(await reasonOf(sig(WEBHOOK_SECRET, nowS() + 10 * 60))).toEqual([
      401,
      'SIGNATURE_INVALID',
      'stale',
    ]);
    expect(await reasonOf(sig('the-wrong-secret'))).toEqual([
      401,
      'SIGNATURE_INVALID',
      'bad_signature',
    ]);
    // signed for another body
    expect(await reasonOf(sig(), body.replace('conv_gate', 'conv_other'))).toEqual([
      401,
      'SIGNATURE_INVALID',
      'bad_signature',
    ]);
    expect(log.error).toHaveBeenCalledWith(
      'voice.webhook_rejected',
      expect.objectContaining({ alert: true, reason: 'bad_signature' }),
    );
    // the secret never reaches a log line
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(WEBHOOK_SECRET);
  });

  it('a signed body that is not JSON or has no type / data: 200 {ok:false} (a retry cannot fix it)', async () => {
    const { a } = app({ ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    for (const [b, reason] of [
      ['not json', 'invalid_json'],
      ['{"data":{}}', 'invalid_payload'],
      ['{"type":"post_call_transcription"}', 'invalid_payload'],
      ['{"type":"post_call_transcription","data":{"transcript":[]}}', 'invalid_payload'],
    ] as const) {
      const r = await post(a, sig(WEBHOOK_SECRET, nowS(), b), b);
      expect([b, r.status, await r.json()]).toEqual([b, 200, { ok: false, reason }]);
    }
  });

  it('post_call_audio: 200 and discarded without any DB write; the audio is never logged', async () => {
    const { a, log } = app({ ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const audio = Buffer.from('ID3 pretend mp3 bytes '.repeat(500)).toString('base64');
    const b = JSON.stringify({
      type: 'post_call_audio',
      event_timestamp: nowS(),
      data: { agent_id: AGENT, conversation_id: 'conv_audio', full_audio: audio },
    });
    const r = await post(a, sig(WEBHOOK_SECRET, nowS(), b), b);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, type: 'post_call_audio', discarded: true });
    expect(log.warn).toHaveBeenCalledWith(
      'voice.post_call_audio_discarded',
      expect.objectContaining({ conversation_id: 'conv_audio', bytes: b.length }),
    );
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(logged).not.toContain(audio.slice(0, 64));
  });

  it('an unknown event type: 200, ignored', async () => {
    const { a } = app({ ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const b = JSON.stringify({ type: 'post_call_something_new', data: { conversation_id: 'c' } });
    const r = await post(a, sig(WEBHOOK_SECRET, nowS(), b), b);
    expect([r.status, await r.json()]).toEqual([
      200,
      { ok: true, type: 'post_call_something_new', ignored: 'unknown_type' },
    ]);
  });

  it(`a body over ${EL_WEBHOOK_BODY_LIMIT / 1024 / 1024} MiB is 413 before it is read`, async () => {
    const { a } = app({ ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const r = await a.request(EL_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'Content-Length': String(EL_WEBHOOK_BODY_LIMIT + 1), ...sig() },
      body: 'x'.repeat(EL_WEBHOOK_BODY_LIMIT + 1),
    });
    expect(r.status).toBe(413);
  });
});

/** Mock ElevenLabs token minting (no network). */
let minted = 0;
const RUN = randomUUID().slice(0, 8);
const mockEl: ElevenLabsClient = {
  async conversationToken() {
    minted += 1;
    return { token: `tok_${RUN}_${minted}`, conversation_id: `conv_wh_${RUN}_${minted}` };
  },
};

/** A post_call_transcription body shaped like ElevenLabs' (docs: post-call webhooks). */
function transcription(conversationId: string, o: Record<string, any> = {}) {
  return {
    type: 'post_call_transcription',
    event_timestamp: 1_795_300_100,
    data: {
      agent_id: o.agent_id ?? AGENT,
      conversation_id: conversationId,
      status: o.status ?? 'done',
      user_id: null,
      transcript: o.transcript ?? [
        {
          role: 'agent',
          message: "Order. Court is in session. Logan, Jake: what's the bet?",
          time_in_call_secs: 0,
          tool_calls: [],
          tool_results: [],
        },
        { role: 'user', message: 'Jake flips a bottle. Five bucks.', time_in_call_secs: 4 },
        {
          role: 'agent',
          message: 'Upright on its base?',
          time_in_call_secs: 7,
          tool_calls: [
            {
              type: 'webhook',
              tool_name: 'propose_terms',
              params_as_json: '{"claim":"Jake lands a bottle flip"}',
              tool_details: {
                type: 'webhook',
                method: 'POST',
                url: 'https://youre-on.fly.dev/el/tools/propose_terms',
                headers: { 'X-YO-Tool-Secret': TOOL_SECRET },
              },
            },
          ],
        },
      ],
      metadata: {
        start_time_unix_secs: 1_795_300_000,
        call_duration_secs: 95,
        cost: 412,
        termination_reason: 'Client disconnected: 1000',
        charging: {
          dev_discount: false,
          tier: 'creator',
          llm_price: 0.0012,
          llm_charge: 3,
          call_charge: 409,
          llm_usage: {
            irreversible_generation: {
              model_usage: {
                [o.llm ?? 'claude-haiku-5-5']: {
                  input: { tokens: 5400, price: 0.0054 },
                  output_total: { tokens: 310, price: 0.0016 },
                },
              },
            },
            initiated_generation: { model_usage: {} },
          },
        },
      },
      analysis: {
        call_successful: 'success',
        transcript_summary: 'Logan challenged Jake to a bottle flip.',
        evaluation_criteria_results: {},
        data_collection_results: {},
      },
      conversation_initiation_client_data: {
        dynamic_variables: { party_a_name: 'Logan', party_b_name: 'Jake' },
        conversation_config_override: { agent: { prompt: { llm: 'claude-haiku-5-5' } } },
      },
    },
  };
}

describeDb('POST /webhooks/elevenlabs over Postgres', () => {
  let ctx: Ctx;
  const logs: { level: string; msg: string; fields: any }[] = [];

  beforeAll(async () => {
    ctx = await startTestServer({
      modules: [
        ...routeModules.filter((r) => r.name !== 'voice'),
        createVoiceRoutes({ elevenlabs: mockEl }),
      ],
      env: {
        ELEVENLABS_AGENT_ID: AGENT,
        ELEVENLABS_TOOL_SECRET: TOOL_SECRET,
        ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
    });
    for (const level of ['debug', 'info', 'warn', 'error'] as const)
      ctx.deps.log[level] = (msg, fields) => logs.push({ level, msg, fields });
  });
  afterAll(async () => {
    await ctx?.server.close();
  });

  const hook = (event: unknown, o: { secret?: string; tS?: number } = {}) => {
    const raw = typeof event === 'string' ? event : JSON.stringify(event);
    return postJson(ctx.base, EL_WEBHOOK_PATH, raw, {
      'ElevenLabs-Signature': elevenLabsSignatureHeader(
        o.secret ?? WEBHOOK_SECRET,
        raw,
        o.tS ?? nowS(),
      ),
    });
  };
  const post = (u: SignedUp, path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, 'POST', path, raw));
  };
  const session = async (conversationId: string) =>
    (
      await ctx.deps.db
        .select()
        .from(voiceSessions)
        .where(eq(voiceSessions.el_conversation_id, conversationId))
    )[0];
  const rows = (conversationId: string, type?: string) =>
    ctx.deps.db
      .select()
      .from(auditLog)
      .where(
        and(
          sql`${auditLog.action} LIKE ${`${EL_WEBHOOK_ACTION_PREFIX}%`}`,
          sql`${auditLog.details}->>'conversation_id' = ${conversationId}`,
          ...(type ? [eq(auditLog.action, `${EL_WEBHOOK_ACTION_PREFIX}${type}`)] : []),
        ),
      );

  /** The real flow: A mints a token (pre-mint), then challenges B with that conversation. */
  async function voiceBet(bind = true) {
    const A = await signUp(ctx.base, 'Logan');
    const B = await signUp(ctx.base, 'Jake');
    const room = await post(A, '/v1/rooms', { name: 'Webhook test', kind: 'session' });
    expect(room.status).toBe(201);
    expect((await post(B, '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const tok = await post(A, '/v1/voice/tokens', { purpose: 'terms' });
    expect(tok.status).toBe(201);
    const challenge = () =>
      post(A, '/v1/bets', {
        room_id: room.json!.room_id,
        opponent_user_id: B.session.user.user_id,
        challenge_method: 'list',
        voice_conversation_id: tok.json!.conversation_id,
      });
    let bet_id: string | null = null;
    if (bind) {
      const bet = await challenge();
      expect(bet.status).toBe(201);
      bet_id = bet.json!.bet.bet_id as string;
    }
    return {
      A,
      bet_id,
      challenge,
      conversation_id: tok.json!.conversation_id as string,
      voice_session_id: tok.json!.voice_session_id as string,
    };
  }

  it('post_call_transcription: archived, the session closed, charging / llm_usage kept, the tool secret redacted', async () => {
    const v = await voiceBet();
    const confirm = (heard: string) =>
      postJson(
        ctx.base,
        '/el/tools/confirm_terms',
        { conversation_id: v.conversation_id, bet_id: v.bet_id, heard },
        { 'X-YO-Tool-Secret': TOOL_SECRET },
      );
    expect((await confirm('A')).json).toMatchObject({ ok: false, fix: 'NOT_PROPOSED' });
    const event = transcription(v.conversation_id);
    const r = await hook(event);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      type: 'post_call_transcription',
      conversation_id: v.conversation_id,
      duplicate: false,
      stored: true,
      voice_session_id: v.voice_session_id,
    });

    const [row] = await rows(v.conversation_id, 'post_call_transcription');
    const d = row!.details as any;
    expect(row).toMatchObject({ actor_kind: 'system', bet_id: v.bet_id });
    // the transcript: JCS of data.transcript with the secret header redacted; sha256 on the session
    const expected = event.data.transcript.map((t: any) => structuredClone(t));
    expected[2].tool_calls[0].tool_details.headers['X-YO-Tool-Secret'] = '[redacted]';
    expect(d.transcript_json).toBe(jcs(expected));
    expect(d.transcript_sha256).toBe(sha256Hex(jcs(expected)));
    expect(r.json!.transcript_sha256).toBe(d.transcript_sha256);
    expect(d.redactions).toBe(1);
    expect(JSON.stringify(row!.details)).not.toContain(TOOL_SECRET);
    // which LLM served, and the analysis as evidence
    expect(d.metadata.charging.llm_usage.irreversible_generation.model_usage).toHaveProperty(
      'claude-haiku-5-5',
    );
    expect(d.metadata.charging).toMatchObject({ tier: 'creator', llm_charge: 3, call_charge: 409 });
    expect(d.llms).toEqual(['claude-haiku-5-5']);
    expect(d.analysis.transcript_summary).toBe('Logan challenged Jake to a bottle flip.');
    expect(d.client_data.conversation_config_override.agent.prompt.llm).toBe('claude-haiku-5-5');
    expect(d).toMatchObject({ el_status: 'done', turns: 3, call_duration_secs: 95 });

    const s = await session(v.conversation_id);
    expect(s).toMatchObject({
      status: 'ended',
      transcript_sha256: d.transcript_sha256,
      transcript_key: `audit_log:${row!.id}`,
    });
    expect(s!.ended_at!.getTime()).toBe((1_795_300_000 + 95) * 1000); // start + duration
    // the stored bytes are what the session's hash covers (checkable in SQL)
    const [check] = await ctx.deps.db.execute<{ ok: boolean }>(
      sql`SELECT encode(sha256(convert_to(a.details->>'transcript_json', 'UTF8')), 'hex')
            = v.transcript_sha256 AS ok
          FROM voice_sessions v JOIN audit_log a ON v.transcript_key = 'audit_log:' || a.id
          WHERE v.el_conversation_id = ${v.conversation_id}`,
    );
    expect(check!.ok).toBe(true);
    expect(logs).toContainEqual({
      level: 'info',
      msg: 'voice.post_call',
      fields: expect.objectContaining({
        conversation_id: v.conversation_id,
        llms: ['claude-haiku-5-5'],
        expected_llm: 'claude-haiku-5-5',
        llm_match: true,
      }),
    });
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'voice.transcript_redacted' }),
    );
    // the conversation is over: the judge's tools no longer act for it
    // (before the webhook it answered NOT_PROPOSED: the session was active and bound)
    expect((await confirm('both')).json).toMatchObject({ ok: false, fix: 'WRONG_BET' });
  });

  it('dedupe on (conversation_id, type): a redelivery (even re-signed) is 200 duplicate and changes nothing', async () => {
    const v = await voiceBet();
    const first = await hook(transcription(v.conversation_id));
    expect(first.json).toMatchObject({ stored: true });
    const before = await session(v.conversation_id);
    // ElevenLabs retries with a new timestamp; a different transcript must not overwrite either
    const again = await hook(
      transcription(v.conversation_id, { transcript: [{ role: 'user', message: 'edited' }] }),
      { tS: nowS() + 1 },
    );
    expect(again.status).toBe(200);
    expect(again.json).toEqual({
      ok: true,
      type: 'post_call_transcription',
      conversation_id: v.conversation_id,
      duplicate: true,
    });
    expect(await rows(v.conversation_id)).toHaveLength(1);
    expect(await session(v.conversation_id)).toEqual(before);

    // concurrent deliveries of a fresh conversation: exactly one is stored
    const w = await voiceBet();
    const all = await Promise.all([1, 2, 3, 4].map(() => hook(transcription(w.conversation_id))));
    expect(all.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    expect(all.filter((x) => x.json!.stored === true)).toHaveLength(1);
    expect(all.filter((x) => x.json!.duplicate === true)).toHaveLength(3);
    expect(await rows(w.conversation_id)).toHaveLength(1);

    // the same conversation's other type is its own key
    const fail = await hook({
      type: 'call_initiation_failure',
      data: { agent_id: AGENT, conversation_id: v.conversation_id, failure_reason: 'late' },
    });
    expect(fail.json).toMatchObject({ duplicate: false });
    expect(await rows(v.conversation_id)).toHaveLength(2);
  });

  it("a failed call (data.status 'failed') closes the session as failed", async () => {
    const v = await voiceBet();
    await hook(transcription(v.conversation_id, { status: 'failed' }));
    expect(await session(v.conversation_id)).toMatchObject({ status: 'failed' });
  });

  it('a pre-minted session that ended unbound keeps status active (CHECK) but cannot be bound any more', async () => {
    const v = await voiceBet(false);
    expect((await hook(transcription(v.conversation_id))).json).toMatchObject({ stored: true });
    const s = await session(v.conversation_id);
    expect(s).toMatchObject({ bet_id: null, status: 'active' });
    expect(s!.ended_at).not.toBeNull();
    expect(s!.transcript_sha256).toMatch(/^[0-9a-f]{64}$/);
    const bet = await v.challenge();
    expect(bet.status).toBe(422);
    expect(JSON.stringify(bet.json)).toContain('session has ended');
  });

  it("our agent's conversation without a session row (a dashboard test call) is archived with no bet", async () => {
    const conv = `conv_dash_${randomUUID()}`;
    const r = await hook(transcription(conv));
    expect(r.json).toMatchObject({ stored: true, voice_session_id: null });
    const [row] = await rows(conv, 'post_call_transcription');
    expect(row).toMatchObject({ bet_id: null, subject_user_id: null });
    expect((row!.details as any).llms).toEqual(['claude-haiku-5-5']);
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: 'voice.post_call_unknown_conversation',
        fields: expect.objectContaining({ conversation_id: conv }),
      }),
    );
  });

  it("another agent's conversation (same workspace) is acknowledged and not stored", async () => {
    const conv = `conv_other_${randomUUID()}`;
    const r = await hook(transcription(conv, { agent_id: 'agent_someone_else' }));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: true,
      type: 'post_call_transcription',
      conversation_id: conv,
      ignored: 'foreign_agent',
    });
    expect(await rows(conv)).toHaveLength(0);
  });

  it('another model billed the call: stored, and voice.llm_mismatch warns', async () => {
    const v = await voiceBet();
    await hook(transcription(v.conversation_id, { llm: 'gpt-5-mini' }));
    expect(logs).toContainEqual({
      level: 'warn',
      msg: 'voice.llm_mismatch',
      fields: expect.objectContaining({
        conversation_id: v.conversation_id,
        llms: ['gpt-5-mini'],
        expected_llm: 'claude-haiku-5-5',
      }),
    });
  });

  it('a NUL or lone surrogate in a turn is stored as U+FFFD (not a 500 on every retry)', async () => {
    const v = await voiceBet();
    const r = await hook(
      transcription(v.conversation_id, {
        transcript: [{ role: 'user', message: 'nul\u0000 and \uD800 lone' }],
      }),
    );
    expect(r.status).toBe(200);
    const [row] = await rows(v.conversation_id);
    expect(JSON.parse((row!.details as any).transcript_json)).toEqual([
      { role: 'user', message: 'nul\uFFFD and \uFFFD lone' },
    ]);
  });

  it('post_call_audio: 200, discarded, the session untouched and nothing stored', async () => {
    const v = await voiceBet();
    const before = await session(v.conversation_id);
    const r = await hook({
      type: 'post_call_audio',
      event_timestamp: nowS(),
      data: {
        agent_id: AGENT,
        conversation_id: v.conversation_id,
        full_audio: Buffer.from('mp3').toString('base64'),
      },
    });
    expect([r.status, r.json]).toEqual([
      200,
      { ok: true, type: 'post_call_audio', discarded: true },
    ]);
    expect(await rows(v.conversation_id)).toHaveLength(0);
    expect(await session(v.conversation_id)).toEqual(before);
  });

  it('call_initiation_failure: logged, one audit row, deduped; the session is left as it was', async () => {
    const v = await voiceBet();
    const event = {
      type: 'call_initiation_failure',
      event_timestamp: nowS(),
      data: {
        agent_id: AGENT,
        conversation_id: v.conversation_id,
        failure_reason: 'agent unavailable',
        metadata: { type: 'sip', body: { from: '+15550100' } },
      },
    };
    const r = await hook(event);
    expect([r.status, r.json]).toEqual([
      200,
      {
        ok: true,
        type: 'call_initiation_failure',
        conversation_id: v.conversation_id,
        duplicate: false,
      },
    ]);
    expect(logs).toContainEqual({
      level: 'warn',
      msg: 'voice.call_initiation_failure',
      fields: expect.objectContaining({
        conversation_id: v.conversation_id,
        voice_session_id: v.voice_session_id,
        failure_reason: 'agent unavailable',
      }),
    });
    expect((await hook(event)).json).toMatchObject({ duplicate: true });
    const all = await rows(v.conversation_id, 'call_initiation_failure');
    expect(all).toHaveLength(1);
    expect(all[0]!.details).toMatchObject({ failure_reason: 'agent unavailable' });
    expect(JSON.stringify(all[0]!.details)).not.toContain('+15550100'); // no provider body
    expect(await session(v.conversation_id)).toMatchObject({ status: 'active', ended_at: null });
  });

  it('a bad or stale signature stores nothing, even for a known conversation', async () => {
    const v = await voiceBet();
    expect((await hook(transcription(v.conversation_id), { secret: 'not-it' })).status).toBe(401);
    expect(
      (await hook(transcription(v.conversation_id), { tS: nowS() - 2 * 60 * 60 })).status,
    ).toBe(401);
    const unsigned = await postJson(ctx.base, EL_WEBHOOK_PATH, transcription(v.conversation_id));
    expect(unsigned.status).toBe(401);
    expect(await rows(v.conversation_id)).toHaveLength(0);
    expect(await session(v.conversation_id)).toMatchObject({
      transcript_sha256: null,
      ended_at: null,
    });
  });
});
