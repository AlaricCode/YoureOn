/**
 * Read-side integration seam between service modules (booth-world-events).
 *
 * The replay booth, the receipt and World Mode need data that other service
 * modules own (bets mirror, drafts, chunk records, witness registrations,
 * perception results, acceptances, huddles, BetView). Instead of importing
 * those modules (they are developed independently), they read through this
 * `BetSources` interface:
 *   - every resolver has a default that reads the owning module's JSON
 *     collection defensively (field names from §12.2/§12.3 request/response
 *     shapes, which those modules are expected to persist);
 *   - an owning module can replace any resolver with
 *     `setBetSources(ctx, { chunks: … })` for an exact answer.
 * The chain (Bet / TrackBuffer accounts) stays the source of truth for
 * everything consensus-relevant.
 */
import { RECENT_HUDDLE_S, programHash, readback as engineReadback, type BetAccount, type Calibration, type Program } from '@verdict/engine';
import type { AppContext } from '../context.js';
import { COLLECTIONS, type UserRecord } from '../persistence/records.js';

export const WORLD_BETS_COLLECTION = 'world_bets';
export const PERCEPTION_COLLECTION = 'perception';

export interface BetArtifacts {
  program: Program;
  yaml: string | null;
  readback: string[];
  labels: Record<string, string>;
  title: string | null;
  calibration: Calibration | null;
  /** creator's dictation (ai_judged judges see it) */
  transcript: string | null;
}

/** One chunk hash record (§12.3 POST /bets/:id/chunks fields). */
export interface ChunkMeta {
  witness_key: string;
  index: number;
  kind: number;
  body_format: string;
  start_ms: number;
  duration_ms: number;
  body_sha256: string;
  chunk_hash: string | null;
  prev_hash: string | null;
  final: boolean;
  late: boolean;
}

export interface WitnessMeta {
  witness_key: string;
  kind: 'camera' | 'audio' | 'detections';
  user_id: string | null;
  label: string | null;
  /** device-local → session time offset (§7.5); session_ms = local_ms − offset_ms */
  offset_ms: number | null;
  synced: boolean | null;
}

export interface PerceptionHostMeta {
  provider: string;
  job_id: string;
  url: string | null;
  network: 'mainnet' | 'mock';
  model_hash: string;
}

export interface PerceptionMeta {
  hosts: PerceptionHostMeta[];
  agreed: boolean;
  entity_agreement_bps: Record<string, number>;
  audio_disagree: boolean | null;
  phone_disagree: boolean | null;
}

export interface AcceptanceMeta {
  user_id: string;
  accepted: boolean;
  voice_cos_bps: number | null;
}

export interface BetSources {
  artifacts(betId: string, bet: BetAccount | null): Promise<BetArtifacts | null>;
  chunks(betId: string, witnessKey: string): ChunkMeta[];
  witnesses(betId: string): WitnessMeta[];
  perception(betId: string): PerceptionMeta | null;
  acceptances(betId: string): AcceptanceMeta[];
  /** §12.2 BetView of a bet as seen by `userId` (null: not known to the bets module) */
  betView(betId: string, userId: string): Promise<unknown | null>;
  /** true iff both users are confirmed members of a huddle created within RECENT_HUDDLE_S (§11.4 step 1, §8.3 pay set) */
  arePeers(userId: string, otherUserId: string): boolean;
}

const overrides = new WeakMap<AppContext, Partial<BetSources>>();

/** Registers exact resolvers (owning modules call this once at registration). */
export function setBetSources(ctx: AppContext, s: Partial<BetSources>): void {
  overrides.set(ctx, { ...(overrides.get(ctx) ?? {}), ...s });
}

export function betSources(ctx: AppContext): BetSources {
  const d = defaultSources(ctx);
  const o = overrides.get(ctx) ?? {};
  return {
    artifacts: o.artifacts ?? d.artifacts,
    chunks: o.chunks ?? d.chunks,
    witnesses: o.witnesses ?? d.witnesses,
    perception: o.perception ?? d.perception,
    acceptances: o.acceptances ?? d.acceptances,
    betView: o.betView ?? d.betView,
    arePeers: o.arePeers ?? d.arePeers,
  };
}

// ---- helpers ---------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const bool = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null);

export function userByWallet(ctx: AppContext, wallet: string): UserRecord | undefined {
  return ctx.store.collection<UserRecord>(COLLECTIONS.users).find((u) => u.wallet === wallet);
}

export function userById(ctx: AppContext, id: string): UserRecord | undefined {
  return ctx.store.collection<UserRecord>(COLLECTIONS.users).get(id);
}

/** Display name for a wallet (falls back to a shortened key). */
export function nameOfWallet(ctx: AppContext, wallet: string): string {
  return userByWallet(ctx, wallet)?.display_name ?? `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

function isProgram(x: unknown): x is Program {
  return isRec(x) && typeof x['kind'] === 'string' && Array.isArray(x['participants']) && Array.isArray(x['legs']);
}

/** Picks artifacts out of a record shaped like a draft/bet mirror (top level or nested `draft`). */
export function artifactsFromRecord(r: unknown): Omit<BetArtifacts, 'readback'> & { readback: string[] | null } | null {
  if (!isRec(r)) return null;
  const src = isProgram(r['program']) ? r : isRec(r['draft']) && isProgram((r['draft'] as Rec)['program']) ? (r['draft'] as Rec) : null;
  if (!src) return null;
  const labels = isRec(src['labels']) ? (src['labels'] as Record<string, string>) : isRec(r['labels']) ? (r['labels'] as Record<string, string>) : {};
  const rb = Array.isArray(src['readback']) ? src['readback'] : Array.isArray(r['readback']) ? r['readback'] : null;
  const cal = r['calibration'] ?? src['calibration'];
  return {
    program: src['program'] as Program,
    yaml: str(src['yaml']) ?? str(r['yaml']),
    readback: rb ? rb.filter((x): x is string => typeof x === 'string') : null,
    labels,
    title: str(r['title']) ?? str(src['title']),
    calibration: isRec(cal) ? (cal as unknown as Calibration) : null,
    transcript: str(src['transcript']) ?? str(r['transcript']),
  };
}

function betKeyOf(r: Rec): string | null {
  return str(r['bet']) ?? str(r['bet_id']) ?? str(r['betId']);
}

function defaultSources(ctx: AppContext): BetSources {
  const col = <T = Rec>(name: string) => ctx.store.collection<T>(name);

  const completeReadback = (a: NonNullable<ReturnType<typeof artifactsFromRecord>>): BetArtifacts => {
    let rb = a.readback;
    if (!rb) {
      const names: Record<string, string> = {};
      for (const w of a.program.participants) names[w] = nameOfWallet(ctx, w);
      try {
        rb = engineReadback(a.program, { names, labels: a.labels });
      } catch {
        rb = [];
      }
    }
    return { ...a, readback: rb };
  };

  return {
    async artifacts(betId, bet) {
      for (const name of [WORLD_BETS_COLLECTION, COLLECTIONS.bets]) {
        const a = artifactsFromRecord(col(name).get(betId));
        if (a) return completeReadback(a);
      }
      // Drafts carry the program; match by program_hash against the chain.
      if (bet) {
        const draft = col(COLLECTIONS.drafts).find((d) => {
          if (!isRec(d)) return false;
          if (d['program_hash'] === bet.program_hash) return isProgram(d['program']);
          return false;
        });
        const a = artifactsFromRecord(draft);
        if (a) return completeReadback(a);
        // Last resort: any bets record whose program hashes to the bet's.
        for (const r of col(COLLECTIONS.bets).values()) {
          const x = artifactsFromRecord(r);
          if (!x) continue;
          try {
            if (programHash(x.program) === bet.program_hash) return completeReadback(x);
          } catch {
            /* not encodable */
          }
        }
      }
      return null;
    },

    chunks(betId, witnessKey) {
      const out: ChunkMeta[] = [];
      for (const r of col(COLLECTIONS.chunks).values()) {
        if (!isRec(r) || betKeyOf(r) !== betId) continue;
        const wk = str(r['witness_key']) ?? str(r['witness']);
        if (wk !== witnessKey) continue;
        const index = num(r['index']);
        const bodySha = str(r['body_sha256']);
        if (index === null || bodySha === null) continue;
        out.push({
          witness_key: wk,
          index,
          kind: num(r['kind']) ?? (r['kind'] === 'audio' ? 1 : r['kind'] === 'detections' ? 2 : 0),
          body_format: str(r['body_format']) ?? 'mp4',
          start_ms: num(r['start_ms']) ?? 0,
          duration_ms: num(r['duration_ms']) ?? 0,
          body_sha256: bodySha.toLowerCase(),
          chunk_hash: str(r['chunk_hash'])?.toLowerCase() ?? null,
          prev_hash: str(r['prev_hash'])?.toLowerCase() ?? null,
          final: bool(r['final']) ?? false,
          late: bool(r['late']) ?? false,
        });
      }
      return out.sort((a, b) => a.index - b.index);
    },

    witnesses(betId) {
      const out: WitnessMeta[] = [];
      const push = (r: unknown) => {
        if (!isRec(r)) return;
        const key = str(r['witness_key']) ?? str(r['key']);
        const kind = r['kind'];
        if (!key || (kind !== 'camera' && kind !== 'audio' && kind !== 'detections')) return;
        if (out.some((w) => w.witness_key === key)) return;
        out.push({
          witness_key: key,
          kind,
          user_id: str(r['user_id']),
          label: str(r['label']),
          offset_ms: num(r['offset_ms']),
          synced: bool(r['synced']),
        });
      };
      for (const r of col(COLLECTIONS.witnesses).values()) {
        if (!isRec(r) || betKeyOf(r) !== betId) continue;
        // Either one record per witness, or one list record per bet ({bet, witnesses: [...]}).
        if (Array.isArray(r['witnesses'])) for (const w of r['witnesses']) push(w);
        else push(r);
      }
      const bet = col(COLLECTIONS.bets).get(betId);
      if (isRec(bet) && Array.isArray(bet['witnesses'])) for (const w of bet['witnesses']) push(w);
      return out;
    },

    perception(betId) {
      const r = col(PERCEPTION_COLLECTION).get(betId) ?? (col(COLLECTIONS.bets).get(betId) as Rec | undefined)?.['perception'];
      if (!isRec(r)) return null;
      const hosts = Array.isArray(r['hosts']) ? r['hosts'].filter(isRec) : [];
      const cc = isRec(r['cross_check']) ? (r['cross_check'] as Rec) : r;
      return {
        hosts: hosts.map((h) => ({
          provider: str(h['provider']) ?? 'unknown',
          job_id: str(h['job_id']) ?? '',
          url: str(h['url']),
          network: h['network'] === 'mainnet' ? 'mainnet' : 'mock',
          model_hash: str(h['model_hash']) ?? '',
        })),
        agreed: bool(cc['ok']) ?? bool(r['agreed']) ?? false,
        entity_agreement_bps: isRec(cc['entity_agreement_bps']) ? (cc['entity_agreement_bps'] as Record<string, number>) : {},
        audio_disagree: bool(r['audio_disagree']),
        phone_disagree: bool(r['phone_disagree']),
      };
    },

    acceptances(betId) {
      const bet = col(COLLECTIONS.bets).get(betId);
      const fromList = (list: unknown): AcceptanceMeta[] =>
        Array.isArray(list)
          ? list.filter(isRec).flatMap((a) => {
              const uid = str(a['user_id']);
              return uid ? [{ user_id: uid, accepted: bool(a['accepted']) ?? true, voice_cos_bps: num(a['voice_cos_bps']) ?? num(a['cos_bps']) }] : [];
            })
          : [];
      if (isRec(bet)) {
        const a = fromList(bet['acceptances']);
        if (a.length) return a;
        const draftId = str(bet['draft_id']);
        if (draftId) {
          const d = col(COLLECTIONS.drafts).get(draftId);
          if (isRec(d)) return fromList(d['acceptances']);
        }
      }
      return [];
    },

    async betView() {
      return null;
    },

    arePeers(userId, otherUserId) {
      if (userId === otherUserId) return false;
      const memberIds = (h: Rec): string[] =>
        (Array.isArray(h['members']) ? h['members'] : []).filter(isRec).flatMap((m) => {
          const id = str(m['user_id']) ?? (isRec(m['user']) ? str((m['user'] as Rec)['id']) : null);
          return id && (m['confirmed'] === true || id === h['creator_user_id']) ? [id] : [];
        });
      const now = ctx.clock.nowMs();
      const recent = (h: Rec) => {
        const created = num(h['created_at_ms']);
        return created === null || now - created <= RECENT_HUDDLE_S * 1000;
      };
      return col(COLLECTIONS.huddles)
        .values()
        .some((h) => isRec(h) && recent(h) && memberIds(h).includes(userId) && memberIds(h).includes(otherUserId));
    },
  };
}
