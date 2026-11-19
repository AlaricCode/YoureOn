// The Simulator's sample Dance Off round (../model/simRound, ../../device/simulator): synthetic
// poses that pass the framing check, run through the real round pipeline so A (follows) beats B
// (lags, stops halfway), key frames that make a valid DanceUpload, and the gate that keeps it off
// every real phone, camera permission or not.
import { DanceUpload } from '@youre-on/shared/evidence';
import { getRoutine } from '@youre-on/shared/dance/routine';
import { framingCheck } from '@youre-on/shared/dance/track';
import { sha256Hex } from '@youre-on/shared/primitives';
import { describe, expect, it } from 'vitest';

import { isSimulatorContainer, simulatorSampleOffered } from '../../device/simulator';
import { createRoundPipeline } from '../model/pipeline';
import { snapshotSchedule } from '../model/round';
import { createSimPoseSource, simJpeg, SIM_FRAME_MS } from '../model/simRound';
import { buildDanceUploadBundle, readSnapshots } from '../model/upload';

const SIM_DOCS =
  'file:///Users/logan/Library/Developer/CoreSimulator/Devices/7A0B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D/data/Containers/Data/Application/0F1E2D3C-4B5A-4968-8776-655443322110/Documents/';
const PHONE_DOCS =
  'file:///var/mobile/Containers/Data/Application/0F1E2D3C-4B5A-4968-8776-655443322110/Documents/';

describe('the Simulator gate (anti-cheat)', () => {
  it('only the Simulator container counts', () => {
    expect(isSimulatorContainer(SIM_DOCS)).toBe(true);
    expect(isSimulatorContainer(PHONE_DOCS)).toBe(false);
    expect(isSimulatorContainer(PHONE_DOCS.replace('/var/', '/private/var/'))).toBe(false);
    expect(isSimulatorContainer(null)).toBe(false);
    expect(isSimulatorContainer('')).toBe(false);
    // the words alone, elsewhere in a real phone's path, are not the Simulator
    expect(
      isSimulatorContainer(
        `${PHONE_DOCS}Library/Developer/CoreSimulator/Devices/x/data/Containers/`,
      ),
    ).toBe(false);
    expect(isSimulatorContainer('file:///Users/logan/Library/Developer/CoreSimulator/')).toBe(
      false,
    );
  });

  it('a real phone never gets the sample round, even with the camera off or denied', () => {
    for (const camera of ['none', 'error', 'ok'] as const)
      expect(simulatorSampleOffered({ platform: 'ios', documentsUri: PHONE_DOCS, camera })).toBe(
        false,
      );
    // the Simulator only when it has no camera
    expect(
      simulatorSampleOffered({ platform: 'ios', documentsUri: SIM_DOCS, camera: 'none' }),
    ).toBe(true);
    expect(simulatorSampleOffered({ platform: 'ios', documentsUri: SIM_DOCS, camera: 'ok' })).toBe(
      false,
    );
    expect(
      simulatorSampleOffered({ platform: 'android', documentsUri: SIM_DOCS, camera: 'none' }),
    ).toBe(false);
  });
});

describe('the sample round', () => {
  const routine = getRoutine('wave-pop')!;

  it('frames like the native view: two people that pass the framing check', () => {
    let t = 1_000;
    const sim = createSimPoseSource(routine, () => t);
    t += 500;
    const f = sim.frame(t);
    expect(f).toMatchObject({ t: 500, ts: 500, w: routine.w, h: routine.h });
    expect(f.people).toHaveLength(2);
    for (const p of f.people) {
      expect(p.k).toHaveLength(57);
      expect(p.k.every((v) => v >= 0 && v <= 1)).toBe(true);
    }
    const fr = framingCheck(
      f.people.map((p) => p.k),
      f.w,
      f.h,
    );
    expect(fr.ok).toBe(true);
  });

  it('runs through the real pipeline: A follows and wins, B lags and stops halfway', async () => {
    let t = 10_000;
    const sim = createSimPoseSource(routine, () => t);
    const p = createRoundPipeline({ routine, syncOffsetMs: 0 });
    // framing + count-in on the session clock
    for (let i = 0; i < 60; i++) {
      t += SIM_FRAME_MS;
      p.push(sim.frame(t));
    }
    p.beginRound();
    const plan = snapshotSchedule(routine);
    expect((await sim.handle.startRound({ snapshotAtMs: plan })).ok).toBe(true);
    const end = t + routine.duration_ms;
    while (t < end) {
      t += SIM_FRAME_MS;
      p.push(sim.frame(t));
    }
    const stop = await sim.handle.stopRound();
    const { series, result } = p.final();
    expect(series.frames.length).toBeGreaterThan(routine.duration_ms / 100);
    expect(result.failed).toBeNull();
    expect(result.winner).toBe('A');
    expect(result.a.score_x10).toBeGreaterThan(result.b.score_x10 + 100);

    // key frames: one per scheduled instant, small valid JPEGs, readable by their uri
    expect(stop.clipUri).toBeNull();
    expect(stop.snapshots.map((s) => s.t_ms)).toEqual(plan.map((x) => Math.round(x)));
    const snaps = await readSnapshots(stop.snapshots, sim.read);
    expect(snaps).toHaveLength(plan.length);
    for (const s of snaps) {
      expect([...s.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect([...s.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
      expect(s.sha256).toBe(sha256Hex(s.bytes));
    }
    expect(new Set(snaps.map((s) => s.sha256)).size).toBe(snaps.length);

    // the upload the bet flow sends (POST …/attempts/:n/dance) builds and parses
    const built = buildDanceUploadBundle({
      routine,
      series,
      result,
      clipSha256: stop.clipSha256,
      snapshots: snaps,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.hashMismatch).toBe(false);
    expect(DanceUpload.safeParse(built.bundle.upload).success).toBe(true);
    expect(built.bundle.upload.client_scores).toEqual({
      a: result.a.score_x10,
      b: result.b.score_x10,
    });
  });

  it('a stopped round with no frames due keeps none; an unknown uri is unreadable', async () => {
    let t = 0;
    const sim = createSimPoseSource(routine, () => t);
    await sim.handle.startRound({ snapshotAtMs: [5_000] });
    t += 100;
    expect((await sim.handle.stopRound()).snapshots).toEqual([]);
    await expect(sim.read('sim://key-frame/9/9')).rejects.toThrow();
    expect((await sim.handle.captureStill()).ok).toBe(false);
    expect(simJpeg('a')).not.toEqual(simJpeg('b'));
  });
});
