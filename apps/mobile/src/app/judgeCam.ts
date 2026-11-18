// Turning this phone into the room's judge cam and back (API-CONTRACT §2.15
// PATCH /v1/devices/current). The server's rules: a judge cam is bound to a room
// (role 'judge_cam' needs room_id) and only a judge cam is (role 'phone' with a room_id is a
// 400). At an attempt it picks the non-performer's most recently seen judge-cam device in the
// room as the recorder, so a phone that left judge-cam mode on screen but not on the server can
// take the recording away from the real judge cam. Every way out of judge-cam mode (the Profile
// row, the judge-cam screen's back arrow) goes through here.
//
// The rule this module keeps: OFF ON SCREEN MEANS 'phone' ON THE SERVER (eventually), and a
// judge cam that comes back after a restart re-binds itself on the server.
//   - The memo in SecureStore is bound to this device AND this user. A demo claim that moves the
//     device to another user resets it to 'phone' on the server (auth/demo-claim.ts), so another
//     user's memo is forgotten, never restored (it used to turn party B's phone into a judge cam
//     that could never see the invite).
//   - A turn-off whose PATCH failed stays in the memo as a pending 'phone' and is re-sent at the
//     next socket 'live' or sign-in; a turn-on that failed sends 'phone' too (the request may have
//     landed, or an older binding to another room may remain).
// Pure TS: tested in node.
import { ApiClientError } from '../net/signedFetch';
import { COPY, t } from '../screens/copy';

export type DeviceRoleRequest =
  | { ok: true; role: 'judge_cam'; roomId: string }
  | { ok: true; role: 'phone'; roomId?: undefined }
  | { ok: false; reason: 'no_room' };

export function deviceRoleRequest(on: boolean, roomId: string | null): DeviceRoleRequest {
  if (!on) return { ok: true, role: 'phone' };
  if (!roomId) return { ok: false, reason: 'no_room' };
  return { ok: true, role: 'judge_cam', roomId };
}

// ---- the memo (SecureStore youreon.judgecam) ----------------------------------------------------

/** Who the memo belongs to: this device key, signed in as this user. */
export interface CamOwner {
  device_id: string;
  user_id: string;
}

export interface JudgeCamMemo extends CamOwner {
  v: 1;
  /** 'judge_cam': come back as the judge cam. 'phone': turned off, the server hasn't confirmed. */
  role: 'judge_cam' | 'phone';
}

export const encodeMemo = (owner: CamOwner, role: JudgeCamMemo['role']): string =>
  JSON.stringify({ v: 1, device_id: owner.device_id, user_id: owner.user_id, role });

export function parseMemo(raw: string | null): JudgeCamMemo | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Partial<JudgeCamMemo> | null;
    if (
      m &&
      m.v === 1 &&
      typeof m.device_id === 'string' &&
      typeof m.user_id === 'string' &&
      (m.role === 'judge_cam' || m.role === 'phone')
    )
      return { v: 1, device_id: m.device_id, user_id: m.user_id, role: m.role };
  } catch {
    // the pre-release bare '1', or junk
  }
  return null;
}

/**
 * At sign-in: what the stored memo means for this owner.
 *   'judge_cam'  come back as the judge cam (and re-bind on the server once the room is joined)
 *   'send_phone' a turn-off the server never confirmed: send it again
 *   'forget'     another user's or device's memo, or an unreadable one: delete it
 *   'none'       nothing stored
 */
export type CamRestore = 'none' | 'judge_cam' | 'send_phone' | 'forget';

export function camRestore(raw: string | null, owner: CamOwner | null): CamRestore {
  if (!raw) return 'none';
  const m = parseMemo(raw);
  if (!m) return 'forget';
  if (!owner) return 'none';
  if (m.device_id !== owner.device_id || m.user_id !== owner.user_id) return 'forget';
  return m.role === 'judge_cam' ? 'judge_cam' : 'send_phone';
}

// ---- keeping the server's role in step -----------------------------------------------------------

export interface JudgeCamSyncDeps {
  /** PATCH /v1/devices/current. */
  setRole(role: 'phone' | 'judge_cam', roomId?: string): Promise<unknown>;
  /** Write the memo, or delete it (null). */
  save(raw: string | null): Promise<void>;
  /** The signed-in device and user, read at call time. */
  owner(): CamOwner | null;
}

/** 'superseded': a later on/off/restore replaced this request; its outcome is not news. */
export type CamSyncResult =
  { status: 'ok' } | { status: 'failed'; error: unknown } | { status: 'superseded' };

export interface JudgeCamSync {
  /** Become the judge cam of this room (the Profile row, or a restored judge cam re-binding). */
  on(roomId: string): Promise<CamSyncResult>;
  /** Back to a plain phone; until the server confirms, a pending 'phone' is remembered. */
  off(): Promise<CamSyncResult>;
  /** Socket 'live' again: re-send a pending 'phone' (null when there is nothing to send). */
  retry(): Promise<CamSyncResult> | null;
  /** Sign-in: read the memo for the current owner (forgets another owner's). */
  restore(raw: string | null): CamRestore;
  readonly phonePending: boolean;
  /** Settles once every memo write issued so far is done (tests). */
  flush(): Promise<void>;
}

const OK: CamSyncResult = { status: 'ok' };
const SUPERSEDED: CamSyncResult = { status: 'superseded' };

export function createJudgeCamSync(d: JudgeCamSyncDeps): JudgeCamSync {
  /** Bumped by every on/off/restore: an older request's outcome must not undo a newer one. */
  let gen = 0;
  let phonePending = false;
  let phoneInFlight = 0;
  // Memo writes run one after another, in the order they were issued.
  let saving: Promise<void> = Promise.resolve();
  const remember = (role: JudgeCamMemo['role'] | null) => {
    const owner = d.owner();
    const raw = role && owner ? encodeMemo(owner, role) : null;
    saving = saving.then(() => d.save(raw)).catch(() => undefined);
  };

  async function off(): Promise<CamSyncResult> {
    const my = ++gen;
    phonePending = true;
    remember('phone');
    phoneInFlight++;
    try {
      await d.setRole('phone');
      if (my !== gen) return SUPERSEDED;
      phonePending = false;
      remember(null);
      return OK;
    } catch (error) {
      return my === gen ? { status: 'failed', error } : SUPERSEDED;
    } finally {
      phoneInFlight--;
    }
  }

  async function on(roomId: string): Promise<CamSyncResult> {
    const my = ++gen;
    phonePending = false;
    remember('judge_cam');
    try {
      await d.setRole('judge_cam', roomId);
      return my === gen ? OK : SUPERSEDED;
    } catch (error) {
      if (my !== gen) return SUPERSEDED;
      // The caller turns it off on screen: make the server agree.
      void off();
      return { status: 'failed', error };
    }
  }

  return {
    on,
    off,
    retry: () => (phonePending && phoneInFlight === 0 ? off() : null),
    restore(raw) {
      gen++;
      const r = camRestore(raw, d.owner());
      phonePending = r === 'send_phone';
      if (r === 'forget') remember(null);
      return r;
    },
    get phonePending() {
      return phonePending;
    },
    flush: () => saving,
  };
}

// ---- POST /attempts errors on A's Start ----------------------------------------------------------

/**
 * What A's "Start" says when POST /v1/bets/:id/attempts fails, or null for nothing. An
 * INVALID_STATE is usually a benign race (the voice judge or a double tap started it already),
 * but 'no_judge_cam' means no device in the room is the judge cam on the server: say so, or
 * Start just does nothing on stage.
 */
export function attemptStartAlert(e: unknown): string | null {
  if (e instanceof ApiClientError) {
    if (e.code === 'INVALID_STATE')
      return e.details?.reason === 'no_judge_cam' ? t(COPY.live.noJudgeCam) : null;
    if (e.code === 'NETWORK') return t(COPY.app.offline);
  }
  return t(COPY.app.failed);
}
