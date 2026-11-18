// ElevenLabs post-call webhook (API-CONTRACT §4.6, DATA-MODEL §5.10 / §9):
//   POST /webhooks/elevenlabs   ElevenLabs-Signature HMAC (./webhook-signature), no bearer auth
//
// - ELEVENLABS_WEBHOOK_SECRET unset -> 404 for every request (signed or not): the route does not
//   exist until the operator has the secret, so unsigned data is never accepted.
// - Missing / malformed / stale / bad signature -> 401 SIGNATURE_INVALID, nothing read or stored.
// - post_call_transcription: the transcript is archived and the voice_sessions row is closed in
//   ONE DB transaction, then 200 (§4.6 ack: within 1 s, after the DB write).
// - post_call_audio: 200 and discarded. Audio is never stored (DATA-MODEL §10); enable only
//   transcripts in the ElevenLabs webhook settings.
// - call_initiation_failure: logged (`voice.call_initiation_failure`) plus a small audit row.
// - Dedupe on (conversation_id, type): a repeat is 200 {duplicate: true} and changes nothing.
// - A signed body that is not JSON or lacks a conversation id is 200 {ok: false} with an alert:
//   a retry would fail the same way, and repeated failures auto-disable the webhook (§4.6).
//   Only a transient DB error answers 503 (retry).
//
// Storage (deviation, reported): DATA-MODEL §9 puts the transcript at
// `evidence/transcripts/{bet_id}/{el_conversation_id}.json` in object storage, which is not wired
// (no S3 client in the server yet). Until it is, the transcript is kept in Postgres, with no
// migration: one append-only `audit_log` row per (conversation_id, type), action
// `el_webhook.<type>`. details.transcript_json is the JCS (RFC 8785) of `data.transcript` and
// voice_sessions.transcript_sha256 = sha256(UTF-8(it)), checkable in SQL:
//   encode(sha256(convert_to(details->>'transcript_json', 'UTF8')), 'hex')
// voice_sessions.transcript_key = `audit_log:<id>` points at that row. details also keeps
// data.metadata (charging / llm_usage: which LLM really served, FINDINGS §6 step 1), data.analysis
// and the conversation_initiation_client_data (dynamic variables and the requested overrides).
// The dedupe is an advisory transaction lock on (conversation_id, type) plus a lookup of that row.
//
// Hygiene: any copy of ELEVENLABS_TOOL_SECRET / ELEVENLABS_API_KEY / ELEVENLABS_WEBHOOK_SECRET
// (and any X-YO-Tool-Secret header value) found in the payload is replaced with "[redacted]"
// before it is stored or hashed (a webhook tool call's record could echo its request headers);
// so are the characters JCS / jsonb refuse (lone surrogates, NUL), with U+FFFD.
// Only conversations of ours are archived: one with a voice_sessions row, or of the agent
// ELEVENLABS_AGENT_ID (a dashboard test call). Another agent's in the same workspace is ignored.
import type { Context } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, voiceSessions } from '@youre-on/db';
import { DEFAULT_AGENT_LLM, TOOL_SECRET_HEADER } from '@youre-on/shared/judge/el-config';
import { jcs } from '@youre-on/shared/jcs';
import type { AppDeps, AppEnv } from '../context';
import { errorBody, HttpError } from '../errors';
import { sha256Hex } from '../crypto';
import { dbErrorSummary, isTransientDbError } from '../chain/db-errors';
import {
  checkElSignatureHeader,
  EL_SIGNATURE_HEADER,
  EL_WEBHOOK_PATH,
  elSignatureMatches,
  type ElSignatureRejectReason,
} from './webhook-signature';

export { EL_WEBHOOK_PATH };
/**
 * A transcript is tens to hundreds of KB. The cap also admits a short call's post_call_audio
 * (base64 MP3, ~1 MB a minute) so it is verified and discarded with a 200 instead of a 413 that
 * counts toward ElevenLabs auto-disabling the webhook. Audio stays off in the settings.
 */
export const EL_WEBHOOK_BODY_LIMIT = 16 * 1024 * 1024;
export const EL_WEBHOOK_ACTION_PREFIX = 'el_webhook.';

export const POST_CALL_TYPES = [
  'post_call_transcription',
  'post_call_audio',
  'call_initiation_failure',
] as const;
export type PostCallType = (typeof POST_CALL_TYPES)[number];

const REDACTED = '[redacted]';
/** Shorter values are not looked for (a real secret is long; a short one would redact words). */
const MIN_REDACT_LEN = 8;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 256): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A lone UTF-16 surrogate (JCS refuses it) or NUL (Postgres jsonb refuses it). */
const UNSTORABLE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/g;
const storable = (s: string) => s.replace(UNSTORABLE, '\uFFFD');

/**
 * Deep copy ready to store and hash: every secret value (and X-YO-Tool-Secret header) replaced
 * with "[redacted]" (counted), and characters JCS or jsonb would refuse replaced with U+FFFD, so
 * one odd transcript cannot fail every retry.
 */
export function scrubForStorage(value: unknown, secrets: readonly (string | undefined)[]) {
  const needles = secrets.filter((s): s is string => !!s && s.length >= MIN_REDACT_LEN);
  const header = TOOL_SECRET_HEADER.toLowerCase();
  let hits = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (needles.some((n) => v.includes(n))) {
        hits += 1;
        return REDACTED;
      }
      return storable(v);
    }
    if (typeof v === 'number' && !Number.isFinite(v)) return null; // JSON.parse('1e400')
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) {
      const out: Obj = {};
      for (const [k, x] of Object.entries(v)) {
        if (k.toLowerCase() === header && x !== null && x !== REDACTED) {
          hits += 1;
          out[storable(k)] = REDACTED;
        } else out[storable(k)] = walk(x);
      }
      return out;
    }
    return v;
  };
  const out = walk(value);
  return { value: out, redactions: hits };
}

/**
 * The model names that billed tokens: the keys of every `model_usage` object under
 * data.metadata (charging.llm_usage.{irreversible,initiated}_generation.model_usage in the
 * ElevenLabs schema; searched, so a moved field still counts). Sorted, at most 10.
 */
export function servedLlms(metadata: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'model_usage' && isObj(x)) for (const m of Object.keys(x)) found.add(m);
      walk(x, depth + 1);
    }
  };
  walk(metadata, 0);
  return [...found].sort().slice(0, 10);
}

/** When the call ended: start + duration from the metadata, else the event time, else now. */
function endedAtOf(data: Obj, eventTimestamp: number | null, nowMs: number): Date {
  const md = isObj(data.metadata) ? data.metadata : {};
  const start = num(md.start_time_unix_secs);
  if (start !== null)
    return new Date((start + Math.max(0, num(md.call_duration_secs) ?? 0)) * 1000);
  if (eventTimestamp !== null) return new Date(eventTimestamp * 1000);
  return new Date(nowMs);
}

const dedupeLock = (conversationId: string, type: string) =>
  sql`hashtextextended(${`yo:el_webhook:${type}:${conversationId}`}, 0)`;

type Tx = Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0];
type SessionRow = typeof voiceSessions.$inferSelect;

/** Inside the dedupe lock: the earlier row for (conversation_id, type), if any. */
async function priorDelivery(tx: Tx, conversationId: string, type: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${dedupeLock(conversationId, type)})`);
  const [row] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, `${EL_WEBHOOK_ACTION_PREFIX}${type}`),
        sql`${auditLog.details}->>'conversation_id' = ${conversationId}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

async function sessionOf(tx: Tx, conversationId: string): Promise<SessionRow | null> {
  const [s] = await tx
    .select()
    .from(voiceSessions)
    .where(eq(voiceSessions.el_conversation_id, conversationId))
    .for('update')
    .limit(1);
  return s ?? null;
}

/** Ours: a conversation we minted or bound, or one of our agent's (a dashboard test call). */
const isOurs = (deps: AppDeps, s: SessionRow | null, agentId: string | null) =>
  s !== null || (!!deps.env.ELEVENLABS_AGENT_ID && agentId === deps.env.ELEVENLABS_AGENT_ID);

interface Event {
  type: string;
  eventTimestamp: number | null;
  data: Obj;
  conversationId: string;
  agentId: string | null;
  requestId: string;
}

async function onTranscription(deps: AppDeps, ev: Event) {
  const { data, conversationId, agentId } = ev;
  const secrets = [
    deps.env.ELEVENLABS_TOOL_SECRET,
    deps.env.ELEVENLABS_API_KEY,
    deps.env.ELEVENLABS_WEBHOOK_SECRET,
  ];
  const transcript = scrubForStorage(
    Array.isArray(data.transcript) ? data.transcript : [],
    secrets,
  );
  const metadata = scrubForStorage(isObj(data.metadata) ? data.metadata : null, secrets);
  const analysis = scrubForStorage(isObj(data.analysis) ? data.analysis : null, secrets);
  const clientData = scrubForStorage(
    isObj(data.conversation_initiation_client_data)
      ? data.conversation_initiation_client_data
      : null,
    secrets,
  );
  const redactions =
    transcript.redactions + metadata.redactions + analysis.redactions + clientData.redactions;
  const transcriptJson = jcs(transcript.value);
  const transcriptSha = sha256Hex(transcriptJson);
  const llms = servedLlms(metadata.value);
  const expectedLlm = deps.env.ELEVENLABS_AGENT_LLM ?? DEFAULT_AGENT_LLM;
  const llmMatch = llms.length ? llms.some((m) => m.includes(expectedLlm)) : null;
  const elStatus = str(data.status, 32);
  const endedAt = endedAtOf(data, ev.eventTimestamp, deps.now());
  const md = isObj(metadata.value) ? metadata.value : {};

  const r = await deps.db.transaction(async (tx) => {
    const prior = await priorDelivery(tx, conversationId, ev.type);
    if (prior) return { duplicate: true as const, audit_id: prior.id, session: null };
    const s = await sessionOf(tx, conversationId);
    if (!isOurs(deps, s, agentId)) return { ignored: 'foreign_agent' as const };
    const [row] = await tx
      .insert(auditLog)
      .values({
        actor_kind: 'system',
        action: `${EL_WEBHOOK_ACTION_PREFIX}${ev.type}`,
        bet_id: s?.bet_id ?? null,
        subject_user_id: s?.user_id ?? null,
        request_id: ev.requestId,
        details: {
          type: ev.type,
          conversation_id: conversationId,
          agent_id: agentId,
          voice_session_id: s?.id ?? null,
          event_timestamp: ev.eventTimestamp,
          el_status: elStatus,
          termination_reason: str(md.termination_reason, 500),
          call_duration_secs: num(md.call_duration_secs),
          ended_at: endedAt.toISOString(),
          turns: Array.isArray(transcript.value) ? transcript.value.length : 0,
          transcript_sha256: transcriptSha,
          transcript_json: transcriptJson,
          llms,
          expected_llm: expectedLlm,
          metadata: metadata.value,
          analysis: analysis.value,
          client_data: clientData.value,
          redactions,
        },
      })
      .returning({ id: auditLog.id });
    if (s) {
      // voice_sessions_bet_bound: an unbound pre-mint row must stay 'active'; ended_at (and
      // bindVoiceSession refusing an ended session) says it is over.
      const status = elStatus === 'failed' ? ('failed' as const) : ('ended' as const);
      await tx
        .update(voiceSessions)
        .set({
          transcript_key: `audit_log:${row!.id}`,
          transcript_sha256: transcriptSha,
          ended_at: endedAt,
          ...(s.bet_id ? { status } : {}),
        })
        .where(eq(voiceSessions.id, s.id));
    }
    return { duplicate: false as const, audit_id: row!.id, session: s };
  });

  if ('ignored' in r) {
    deps.log.warn('voice.webhook_ignored', {
      type: ev.type,
      conversation_id: conversationId,
      agent_id: agentId,
      reason: r.ignored,
      hint: 'not a conversation of ELEVENLABS_AGENT_ID and no voice_sessions row',
    });
    return { ok: true, type: ev.type, conversation_id: conversationId, ignored: r.ignored };
  }
  const fields = {
    conversation_id: conversationId,
    voice_session_id: r.session?.id ?? null,
    bet_id: r.session?.bet_id ?? null,
    audit_id: String(r.audit_id),
    duplicate: r.duplicate,
  };
  if (r.duplicate) {
    deps.log.info('voice.post_call_duplicate', { type: ev.type, ...fields });
    return { ok: true, type: ev.type, conversation_id: conversationId, duplicate: true };
  }
  deps.log.info('voice.post_call', {
    ...fields,
    el_status: elStatus,
    turns: Array.isArray(transcript.value) ? transcript.value.length : 0,
    transcript_sha256: transcriptSha,
    llms,
    expected_llm: expectedLlm,
    llm_match: llmMatch,
    unbound: r.session ? r.session.bet_id === null : null,
  });
  if (llmMatch === false)
    deps.log.warn('voice.llm_mismatch', {
      conversation_id: conversationId,
      llms,
      expected_llm: expectedLlm,
      hint: 'another model billed this call: check the agent LLM (scripts/el-agent.ts --llm) and backup_llm_config',
    });
  if (redactions)
    deps.log.warn('voice.transcript_redacted', { conversation_id: conversationId, redactions });
  if (!r.session)
    deps.log.warn('voice.post_call_unknown_conversation', {
      conversation_id: conversationId,
      hint: 'our agent, no voice_sessions row (a dashboard test call?): archived with bet_id null',
    });
  return {
    ok: true,
    type: ev.type,
    conversation_id: conversationId,
    duplicate: false,
    stored: true,
    voice_session_id: r.session?.id ?? null,
    transcript_sha256: transcriptSha,
  };
}

async function onInitiationFailure(deps: AppDeps, ev: Event) {
  const { data, conversationId, agentId } = ev;
  const reason = str(data.failure_reason, 500);
  const r = await deps.db.transaction(async (tx) => {
    const prior = await priorDelivery(tx, conversationId, ev.type);
    if (prior) return { duplicate: true as const, session: null };
    const s = await sessionOf(tx, conversationId);
    if (!isOurs(deps, s, agentId)) return { ignored: 'foreign_agent' as const };
    // Not data.metadata: for a phone call it is the provider's request body (phone numbers).
    await tx.insert(auditLog).values({
      actor_kind: 'system',
      action: `${EL_WEBHOOK_ACTION_PREFIX}${ev.type}`,
      bet_id: s?.bet_id ?? null,
      subject_user_id: s?.user_id ?? null,
      request_id: ev.requestId,
      details: {
        type: ev.type,
        conversation_id: conversationId,
        agent_id: agentId,
        voice_session_id: s?.id ?? null,
        event_timestamp: ev.eventTimestamp,
        failure_reason: reason,
      },
    });
    return { duplicate: false as const, session: s };
  });
  if ('ignored' in r) {
    deps.log.warn('voice.webhook_ignored', {
      type: ev.type,
      conversation_id: conversationId,
      agent_id: agentId,
      reason: r.ignored,
    });
    return { ok: true, type: ev.type, conversation_id: conversationId, ignored: r.ignored };
  }
  if (!r.duplicate)
    deps.log.warn('voice.call_initiation_failure', {
      conversation_id: conversationId,
      agent_id: agentId,
      voice_session_id: r.session?.id ?? null,
      bet_id: r.session?.bet_id ?? null,
      failure_reason: reason,
    });
  return { ok: true, type: ev.type, conversation_id: conversationId, duplicate: r.duplicate };
}

function reject(deps: AppDeps, reason: ElSignatureRejectReason, requestId: string): never {
  // ALERT: ElevenLabs auto-disables a webhook that keeps failing (§4.6).
  deps.log.error('voice.webhook_rejected', { alert: true, reason, request_id: requestId });
  throw new HttpError('SIGNATURE_INVALID', 'ElevenLabs signature rejected.', { reason });
}

export function postCallWebhookHandler() {
  return async (c: Context<AppEnv>) => {
    const d = c.get('deps');
    const requestId = c.get('requestId');
    const secret = d.env.ELEVENLABS_WEBHOOK_SECRET;
    if (!secret) {
      d.log.error('voice.webhook_unconfigured', { hint: 'set ELEVENLABS_WEBHOOK_SECRET' });
      throw new HttpError('NOT_FOUND');
    }
    // Cheap rejection before buffering the body: a parseable, fresh signature header.
    const h = checkElSignatureHeader(c.req.header(EL_SIGNATURE_HEADER), d.now());
    if (!h.ok) reject(d, h.reason, requestId);
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (!elSignatureMatches(h.sig, secret, raw)) reject(d, 'bad_signature', requestId);

    // JSON is parsed only after the HMAC over the exact bytes verified.
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
    } catch {
      d.log.error('voice.webhook_bad_json', { alert: true, bytes: raw.length });
      return c.json({ ok: false, reason: 'invalid_json' }, 200);
    }
    const type = isObj(body) ? str(body.type, 64) : null;
    const data = isObj(body) && isObj(body.data) ? body.data : null;
    if (!type || !data) {
      d.log.error('voice.webhook_bad_payload', { alert: true, bytes: raw.length });
      return c.json({ ok: false, reason: 'invalid_payload' }, 200);
    }
    if (type === 'post_call_audio') {
      // Never stored, never logged beyond its size (DATA-MODEL §10).
      d.log.warn('voice.post_call_audio_discarded', {
        conversation_id: str(data.conversation_id, 128),
        bytes: raw.length,
        hint: 'turn off audio in the ElevenLabs post-call webhook settings',
      });
      return c.json({ ok: true, type, discarded: true }, 200);
    }
    if (!(POST_CALL_TYPES as readonly string[]).includes(type)) {
      d.log.warn('voice.webhook_unknown_type', { type, bytes: raw.length });
      return c.json({ ok: true, type, ignored: 'unknown_type' }, 200);
    }
    const conversationId = str(data.conversation_id, 128);
    if (!conversationId) {
      d.log.error('voice.webhook_bad_payload', { alert: true, type, reason: 'no conversation_id' });
      return c.json({ ok: false, reason: 'invalid_payload' }, 200);
    }
    const ev: Event = {
      type,
      eventTimestamp: isObj(body) ? num(body.event_timestamp) : null,
      data,
      conversationId,
      agentId: str(data.agent_id, 128),
      requestId,
    };
    try {
      const res =
        type === 'post_call_transcription'
          ? await onTranscription(d, ev)
          : await onInitiationFailure(d, ev);
      return c.json(res, 200);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // Never log the error itself: a failed query's message carries its parameters (the
      // transcript). The SQLSTATE, constraint and the driver's own message only.
      const db = dbErrorSummary(e);
      if (isTransientDbError(e)) {
        d.log.error('voice.webhook_db_unavailable', { type, conversation_id: conversationId, db });
        return c.json(
          errorBody('INTERNAL', 'Database unavailable; retry.', true, requestId, {
            reason: 'db_unavailable',
          }),
          503,
        );
      }
      d.log.error('voice.webhook_failed', {
        alert: true,
        type,
        conversation_id: conversationId,
        db,
      });
      throw new HttpError('INTERNAL');
    }
  };
}
