import { describe, expect, it } from 'vitest';

import { ApiClientError } from '../../net/signedFetch';
import {
  isNoJudgeCam,
  RECORDING_CAMERA,
  recorderOrder,
  startAttemptVia,
  startsAttempt,
  type Recorder,
} from '../recorder';

const noJudgeCam = () =>
  new ApiClientError('INVALID_STATE', 409, 'No judge cam is set up in this room.', false, {
    state: 'LOCKED',
    reason: 'no_judge_cam',
  });

/**
 * A fake POST /v1/bets/:id/attempts with the server's recorder rules (API-CONTRACT §2.9):
 * 'judge_cam' needs a judge cam in the room; 'self' is refused to the performer.
 */
function fakeServer(o: { judgeCam: boolean; performer: 'A' | 'B'; caller: 'A' | 'B' }) {
  const calls: Recorder[] = [];
  const start = async (recorder: Recorder) => {
    calls.push(recorder);
    if (recorder === 'judge_cam') {
      if (!o.judgeCam) throw noJudgeCam();
      return { recorder_device_id: 'judge-cam' };
    }
    if (o.caller === o.performer)
      throw new ApiClientError('NOT_A_PARTY', 403, "You can't record your own attempt.", false, {
        reason: 'performer_cannot_record',
      });
    return { recorder_device_id: `phone-${o.caller}` };
  };
  return { start, calls };
}

describe('who gets Start (the non-performer: it may have to film)', () => {
  it('B performs: A has Start, B does not', () => {
    expect(startsAttempt('A', 'B')).toBe(true);
    expect(startsAttempt('B', 'B')).toBe(false);
  });
  it('A performs: B has Start, A does not', () => {
    expect(startsAttempt('B', 'A')).toBe(true);
    expect(startsAttempt('A', 'A')).toBe(false);
  });
  it('no performer known yet: A, as before; nobody without a party', () => {
    expect(startsAttempt('A', null)).toBe(true);
    expect(startsAttempt('B', null)).toBe(false);
    expect(startsAttempt(null, 'B')).toBe(false);
  });
});

describe('which recorder a phone asks for', () => {
  it('the judge cam first; the own phone only off the performer', () => {
    expect(recorderOrder('A', 'B')).toEqual(['judge_cam', 'self']);
    expect(recorderOrder('B', 'A')).toEqual(['judge_cam', 'self']);
    expect(recorderOrder('A', 'A')).toEqual(['judge_cam']);
    expect(recorderOrder('B', 'B')).toEqual(['judge_cam']);
    expect(recorderOrder(null, 'B')).toEqual(['judge_cam']);
  });

  for (const performer of ['A', 'B'] as const) {
    const filmer = performer === 'A' ? 'B' : 'A';

    it(`judge cam present, ${performer} performs: the judge cam records (one request)`, async () => {
      const s = fakeServer({ judgeCam: true, performer, caller: filmer });
      const r = await startAttemptVia(s.start, filmer, performer);
      expect(r).toEqual({ recorder: 'judge_cam', result: { recorder_device_id: 'judge-cam' } });
      expect(s.calls).toEqual(['judge_cam']);
    });

    it(`no judge cam, ${performer} performs: ${filmer}'s own phone records`, async () => {
      const s = fakeServer({ judgeCam: false, performer, caller: filmer });
      const r = await startAttemptVia(s.start, filmer, performer);
      expect(r).toEqual({ recorder: 'self', result: { recorder_device_id: `phone-${filmer}` } });
      expect(s.calls).toEqual(['judge_cam', 'self']);
    });

    it(`no judge cam, ${performer} performs: ${performer}'s phone never records itself`, async () => {
      const s = fakeServer({ judgeCam: false, performer, caller: performer });
      const err = await startAttemptVia(s.start, performer, performer).catch((e: unknown) => e);
      expect(isNoJudgeCam(err)).toBe(true);
      expect(s.calls).toEqual(['judge_cam']);
    });
  }

  it("A hosts the voice and films (B performs, no judge cam): request_attempt arms A's phone", async () => {
    const s = fakeServer({ judgeCam: false, performer: 'B', caller: 'A' });
    expect((await startAttemptVia(s.start, 'A', 'B')).recorder).toBe('self');
  });

  it('any other error is not a reason to record yourself', async () => {
    const calls: Recorder[] = [];
    const offline = new ApiClientError('NETWORK', 0, 'offline', true);
    const err = await startAttemptVia(
      async (r) => {
        calls.push(r);
        throw offline;
      },
      'A',
      'B',
    ).catch((e: unknown) => e);
    expect(err).toBe(offline);
    expect(calls).toEqual(['judge_cam']);
    expect(isNoJudgeCam(offline)).toBe(false);
    expect(isNoJudgeCam(new Error('no_judge_cam'))).toBe(false);
  });
});

describe('the recording camera', () => {
  it('records video only: the mic stays with the voice session', () => {
    expect(RECORDING_CAMERA).toMatchObject({ mode: 'video', mute: true, facing: 'back' });
  });
});
