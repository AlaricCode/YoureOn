import { describe, expect, it } from 'vitest';

import { poseSha256, POSE_SCHEMA_VERSION, type PoseSeries } from '@youre-on/shared/dance/pose';
import { getRoutine, routineSha256 } from '@youre-on/shared/dance/routine';
import type { DanceUpload } from '@youre-on/shared/evidence';

import { ApiClientError } from '../../net/signedFetch';
import {
  danceDisplayPresent,
  danceRecorderOrder,
  danceStartNote,
  danceWatchPhase,
  inDanceRound,
  isDanceBet,
  prepareDance,
  recordsDance,
  sendDanceUpload,
  showsDanceDisplay,
  startDanceAttemptVia,
  type DanceBundleIn,
  type PreparedDance,
} from '../danceFlow';
import { DEVICE_A, DEVICE_CAM, dance, danceEnvelope, envelope } from './fixtures';

const noJudgeCam = () =>
  new ApiClientError('INVALID_STATE', 409, 'no judge cam', true, { reason: 'no_judge_cam' });

describe('the display phone and the recorder’s presence check', () => {
  it("B's phone is the display while the round runs (LOCKED, ATTEMPT), never a judge cam", () => {
    const phone = { judgeCam: false };
    expect(showsDanceDisplay(phone, { state: 'LOCKED', my_party: 'B' })).toBe(true);
    expect(showsDanceDisplay(phone, { state: 'ATTEMPT', my_party: 'B' })).toBe(true);
    // Judged: the watch screen and the ruling, as before.
    expect(showsDanceDisplay(phone, { state: 'JUDGING', my_party: 'B' })).toBe(false);
    // A records (or watches the judge cam record): never the display.
    expect(showsDanceDisplay(phone, { state: 'ATTEMPT', my_party: 'A' })).toBe(false);
    expect(showsDanceDisplay({ judgeCam: true }, { state: 'ATTEMPT', my_party: 'B' })).toBe(false);
  });

  const member = (user_id: string, online: boolean) => ({ user: { user_id }, online });
  const base = {
    members: [member('u-a', true), member('u-b', true)],
    roomId: 'room-1',
    betRoomId: 'room-1',
    displayUserId: 'u-b',
    myUserId: 'u-a',
  };

  it('a display phone is there when party B is online in the bet’s room', () => {
    expect(danceDisplayPresent(base)).toBe(true);
    // The bet's room unknown: taken as the current room.
    expect(danceDisplayPresent({ ...base, betRoomId: null })).toBe(true);
  });

  it('none when B is offline, missing, in another room, or is this phone’s own user', () => {
    expect(
      danceDisplayPresent({ ...base, members: [member('u-a', true), member('u-b', false)] }),
    ).toBe(false);
    expect(danceDisplayPresent({ ...base, members: [member('u-a', true)] })).toBe(false);
    expect(danceDisplayPresent({ ...base, members: [] })).toBe(false);
    // The presence list is for another room than the bet's.
    expect(danceDisplayPresent({ ...base, betRoomId: 'room-2' })).toBe(false);
    expect(danceDisplayPresent({ ...base, roomId: null })).toBe(false);
    expect(danceDisplayPresent({ ...base, displayUserId: null })).toBe(false);
    // A judge cam signed in as B only ever sees itself online.
    expect(danceDisplayPresent({ ...base, myUserId: 'u-b' })).toBe(false);
  });
});

describe('which phone records the round', () => {
  const attempt = (recorder: string) => ({
    attempt_no: 1,
    performer: 'A' as const,
    max_ms: 20_000,
    recorder_device_id: recorder,
    go_at: '2026-11-21T18:07:00.000Z',
  });

  it('knows a dance bet by its Terms', () => {
    expect(isDanceBet({ envelope: danceEnvelope() })).toBe(true);
    expect(isDanceBet({ envelope: envelope() })).toBe(false);
    expect(isDanceBet({ envelope: null })).toBe(false);
    expect(dance.terms.type).toBe('dance_off');
  });

  it('the judge cam always; before an attempt A, after it the device it names', () => {
    const phone = { judgeCam: false, deviceId: DEVICE_A };
    const cam = { judgeCam: true, deviceId: DEVICE_CAM };
    expect(recordsDance(cam, { attempt: null, my_party: 'A' })).toBe(true);
    expect(recordsDance(phone, { attempt: null, my_party: 'A' })).toBe(true);
    expect(recordsDance(phone, { attempt: null, my_party: 'B' })).toBe(false);
    expect(recordsDance(phone, { attempt: attempt(DEVICE_A), my_party: 'A' })).toBe(true);
    // The room's judge cam took the round: A's phone watches.
    expect(recordsDance(phone, { attempt: attempt(DEVICE_CAM), my_party: 'A' })).toBe(false);
  });

  it('the round states and the watching phone phases', () => {
    expect(['LOCKED', 'ATTEMPT', 'JUDGING'].every((s) => inDanceRound(s as never))).toBe(true);
    expect(inDanceRound('RULED')).toBe(false);
    expect(inDanceRound(null)).toBe(false);
    expect((['LOCKED', 'ATTEMPT', 'JUDGING'] as const).map(danceWatchPhase)).toEqual([
      'waiting',
      'dancing',
      'judging',
    ]);
  });
});

describe('starting the round', () => {
  it('A asks for the judge cam, then (none in the room) films itself; the cam only itself', () => {
    expect(danceRecorderOrder(false, 'A')).toEqual(['judge_cam', 'self']);
    expect(danceRecorderOrder(true, 'A')).toEqual(['judge_cam']);
    expect(danceRecorderOrder(false, 'B')).toEqual([]);
  });

  it('moves on only for no_judge_cam', async () => {
    const asked: string[] = [];
    const r = await startDanceAttemptVia(
      async (recorder) => {
        asked.push(recorder);
        if (recorder === 'judge_cam') throw noJudgeCam();
        return 'ok';
      },
      false,
      'A',
    );
    expect(r.recorder).toBe('self');
    expect(asked).toEqual(['judge_cam', 'self']);
    const other = new ApiClientError('RATE_LIMITED', 429, 'slow', true);
    await expect(
      startDanceAttemptVia(
        async () => {
          throw other;
        },
        false,
        'A',
      ),
    ).rejects.toBe(other);
    await expect(startDanceAttemptVia(async () => 'ok', false, 'B')).rejects.toThrow();
    expect(danceStartNote(other)).toBe('Try again soon');
    expect(danceStartNote(new Error('x'))).toBe('Try again');
  });
});

// ---- the upload ----------------------------------------------------------------------------

const routine = getRoutine('wave-pop')!;
const series: PoseSeries = {
  schema_version: POSE_SCHEMA_VERSION,
  w: 720,
  h: 1280,
  fps_cap: 30,
  sync_offset_ms: 0,
  frames: [{ t: 0, n: 2, a: null, b: null }],
};
const jpeg = (i: number) => new Uint8Array(100 + i).fill(i + 1);
const SHAS = ['11', '22', '33', '44'].map((x) => x.repeat(32));

function bundle(order: number[] = [0, 1, 2, 3]): DanceBundleIn {
  const upload: DanceUpload = {
    routine_id: routine.id,
    routine_sha256: routineSha256(routine),
    series,
    pose_sha256: poseSha256(series),
    client_scores: { a: 812, b: 640 },
    clip_sha256: null,
    frames: order.map((i) => ({
      index: i,
      t_ms: 1000 * i,
      sha256: SHAS[i]!,
      width: 288,
      height: 512,
      bytes: jpeg(i).length,
    })),
  };
  return {
    upload,
    frames: [3, 2, 1, 0].map((i) => ({ index: i, bytes: jpeg(i), sha256: SHAS[i]! })),
  };
}

describe('dance upload', () => {
  it('puts the frames in upload.frames index order, each with the JPEG it names', () => {
    const p = prepareDance(bundle([2, 0, 3, 1]));
    expect(p.upload.frames.map((f) => f.index)).toEqual([0, 1, 2, 3]);
    expect(p.frames.map((f) => f[0])).toEqual([1, 2, 3, 4]);
  });

  it('refuses a bundle whose JPEG does not match its record', () => {
    const b = bundle();
    const bad = {
      ...b,
      frames: b.frames.map((f) => (f.index === 2 ? { ...f, sha256: SHAS[0]! } : f)),
    };
    expect(() => prepareDance(bad)).toThrow();
    const short = { ...b, frames: b.frames.filter((f) => f.index !== 1) };
    expect(() => prepareDance(short)).toThrow();
  });

  it('a retry resends the first build; a 4xx drops it (a fresh key next)', async () => {
    const sent: { key: string; upload: DanceUpload; frames: readonly Uint8Array[] }[] = [];
    let fail: unknown = new Error('network');
    const api = {
      uploadDance: async (
        _bet: string,
        _n: number,
        upload: DanceUpload,
        frames: readonly Uint8Array[],
        key: string,
      ) => {
        sent.push({ key, upload, frames });
        if (fail) throw fail;
        return {
          judging: true as const,
          evidence_hash: 'ab'.repeat(32),
          pose_sha256: upload.pose_sha256,
          scores: { a: 812, b: 640 },
          client_mismatch: false,
          frame_hashes: SHAS,
        };
      },
    };
    const cache = new Map<string, PreparedDance>();
    const first = await sendDanceUpload(
      { api },
      { betId: 'b1', attemptNo: 1, bundle: bundle(), idempotencyKey: 'k1' },
      cache,
    );
    expect(first).toEqual({ ok: false, message: 'Upload failed', freshKey: false });
    // The screen hands over a rebuilt bundle (other client scores): the first build goes again.
    const rebuilt = bundle();
    rebuilt.upload.client_scores = { a: 1, b: 2 };
    fail = null;
    const second = await sendDanceUpload(
      { api },
      { betId: 'b1', attemptNo: 1, bundle: rebuilt, idempotencyKey: 'k1' },
      cache,
    );
    expect(second).toEqual({ ok: true });
    expect(sent[1]!.upload).toEqual(sent[0]!.upload);
    expect(sent[1]!.upload.client_scores).toEqual({ a: 812, b: 640 });

    fail = new ApiClientError('VALIDATION_FAILED', 422, 'bad', false);
    const refused = await sendDanceUpload(
      { api },
      { betId: 'b1', attemptNo: 2, bundle: bundle(), idempotencyKey: 'k2' },
      cache,
    );
    expect(refused).toEqual({ ok: false, message: 'Upload failed', freshKey: true });
    expect(cache.has('k2')).toBe(false);
    fail = new ApiClientError('INVALID_STATE', 409, 'over', true);
    const closed = await sendDanceUpload(
      { api },
      { betId: 'b1', attemptNo: 3, bundle: bundle(), idempotencyKey: 'k3' },
      cache,
    );
    expect(closed).toMatchObject({ ok: false, message: 'Round closed', freshKey: true });
  });

  it('a bundle that does not parse never reaches the server', async () => {
    let calls = 0;
    const api = {
      uploadDance: async () => {
        calls++;
        throw new Error('unreachable');
      },
    };
    const b = bundle();
    const broken = { ...b, upload: { ...b.upload, pose_sha256: 'nope' } };
    const r = await sendDanceUpload(
      { api },
      { betId: 'b1', attemptNo: 1, bundle: broken, idempotencyKey: 'k9' },
    );
    expect(r).toEqual({ ok: false, message: 'Upload failed', freshKey: false });
    expect(calls).toBe(0);
  });
});
