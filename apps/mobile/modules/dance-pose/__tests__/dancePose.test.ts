// The DancePose module (DANCE-OFF.md §6.1): pure payload helpers, plus source-scanning guards that
// keep the Swift side, the JS side and the build config in step (nothing native runs in node).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_FPS,
  JOINT_ORDER,
  KEYPOINT_COUNT,
  clampMaxFps,
  emptyStopResult,
  joint,
  toKeypoints,
  toPoseFrame,
  toStatusEvent,
  toStillResult,
  toStopRoundResult,
} from '../src/frame';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), 'utf8');

const SHA = 'ab'.repeat(32);
const person = (fill = 0.5) => Array.from({ length: 57 }, () => fill);

describe('joint order', () => {
  it('is the contract order: 19 Apple Vision joints, 57 numbers per person', () => {
    expect(JOINT_ORDER).toEqual([
      'nose',
      'leftEye',
      'rightEye',
      'leftEar',
      'rightEar',
      'neck',
      'leftShoulder',
      'rightShoulder',
      'leftElbow',
      'rightElbow',
      'leftWrist',
      'rightWrist',
      'root',
      'leftHip',
      'rightHip',
      'leftKnee',
      'rightKnee',
      'leftAnkle',
      'rightAnkle',
    ]);
    expect(KEYPOINT_COUNT).toBe(57);
  });

  it('matches the Swift extraction order', () => {
    const swift = read('../ios/PoseExtraction.swift');
    const order = /jointOrder: \[VNHumanBodyPoseObservation\.JointName\] = \[([\s\S]*?)\]/;
    const block = order.exec(swift);
    expect(block).not.toBeNull();
    const names = [...(block?.[1] ?? '').matchAll(/\.(\w+),/g)].map((m) => m[1]);
    expect(names).toEqual([...JOINT_ORDER]);
    expect(swift).toContain('static let valuesPerPerson = 57');
  });

  it('pins the Vision request revision and converts to a top-left origin', () => {
    const swift = read('../ios/PoseExtraction.swift');
    expect(swift).toContain('request.revision = VNDetectHumanBodyPoseRequestRevision1');
    expect(swift).toContain('1 - Double(point.location.y)');
    const engine = read('../ios/DancePoseEngine.swift');
    // Buffers arrive upright (the output connection is rotated to portrait), so Vision gets .up.
    expect(engine).toContain('orientation: .up');
    expect(engine).toContain('connection.videoRotationAngle = 90');
    expect(engine).toContain('connection.videoOrientation = .portrait');
  });
});

describe('native contract (Swift <-> JS)', () => {
  const moduleSwift = read('../ios/DancePoseModule.swift');
  const viewSwift = read('../ios/DancePoseView.swift');
  const nativeTs = read('../src/native.ts');

  it('autolinks DancePoseModule for apple only', () => {
    const config = JSON.parse(read('../expo-module.config.json')) as {
      platforms: string[];
      apple: { modules: string[] };
    };
    expect(config.platforms).toEqual(['apple']);
    expect(config.apple.modules).toEqual(['DancePoseModule']);
    expect(moduleSwift).toMatch(/public final class DancePoseModule: Module \{/);
  });

  it('uses one module name on both sides', () => {
    expect(moduleSwift).toContain('Name("DancePose")');
    expect(nativeTs).toContain("export const DANCE_POSE_MODULE = 'DancePose';");
  });

  it('declares the events, props and view functions the JS wrapper uses', () => {
    expect(moduleSwift).toContain('Events("onPoses", "onStatus")');
    // EventDispatchers are bound by property name.
    expect(viewSwift).toContain('let onPoses = EventDispatcher()');
    expect(viewSwift).toContain('let onStatus = EventDispatcher()');
    for (const prop of ['active', 'maxFps']) {
      expect(moduleSwift).toContain(`Prop("${prop}")`);
      expect(nativeTs).toMatch(new RegExp(`\\b${prop}: `));
    }
    for (const fn of ['startRound', 'stopRound', 'captureStill']) {
      expect(moduleSwift).toContain(`AsyncFunction("${fn}") { (view: DancePoseView`);
      expect(nativeTs).toMatch(new RegExp(`\\b${fn}\\??\\(`));
    }
    expect(moduleSwift).toContain('@Field var snapshotAtMs: [Double] = []');
  });

  it('returns the stopRound and snapshot keys the types promise', () => {
    const engine = read('../ios/DancePoseEngine.swift');
    for (const key of ['"clipUri"', '"clipSha256"', '"snapshots"', '"people"', '"fps"', '"ts"']) {
      expect(engine).toContain(key);
    }
    const files = read('../ios/DancePoseFiles.swift');
    for (const key of ['"t_ms"', '"uri"', '"width"', '"height"', '"bytes"', '"sha256"']) {
      expect(files).toContain(key);
    }
  });

  it("captureStill: a full-size still of a pose frame, with that frame's ts", () => {
    const engine = read('../ios/DancePoseEngine.swift');
    expect(viewSwift).toContain('func captureStill(promise: Promise)');
    for (const key of ['"ok"', '"uri"', '"width"', '"height"', '"ts": ts']) {
      expect(engine).toContain(key);
    }
    // Served from the frame handed to Vision, so its ts is an onPoses ts.
    const dispatch = engine.indexOf('enqueueStill(pixelBuffer, ts: frameTs');
    expect(dispatch).toBeGreaterThan(engine.indexOf('visionBusy.set(true)'));
    expect(read('../ios/DancePoseFiles.swift')).toContain(
      'static let stillMaxLongSide: CGFloat = 1280',
    );
  });

  it('does not touch native code at import time', () => {
    // Every native lookup sits inside a function (getNativeDancePoseView / isDancePoseAvailable).
    const topLevel = nativeTs
      .split('\n')
      .filter((l) => /^(const|let|export const)\b/.test(l) && /require(Optional)?Native/.test(l));
    expect(topLevel).toEqual([]);
  });
});

describe('build config', () => {
  type AppJson = { expo: { ios: { deploymentTarget: string } } };
  const app = (JSON.parse(read('../../../app.json')) as AppJson).expo;

  it('targets the app deployment target and depends on ExpoModulesCore', () => {
    const podspec = read('../ios/DancePose.podspec');
    expect(podspec).toContain(`:ios => '${app.ios.deploymentTarget}'`);
    expect(podspec).toContain("s.dependency 'ExpoModulesCore'");
    for (const framework of ["'AVFoundation'", "'Vision'", "'CoreImage'", "'CryptoKit'"]) {
      expect(podspec).toContain(framework);
    }
  });

  it('uploads the module ios/ folder to EAS (the repo-wide ios/ rule would drop it)', () => {
    const rules = read('../../../../../.easignore')
      .split('\n')
      .map((l) => l.trim());
    const drop = rules.indexOf('ios/');
    const keep = rules.indexOf('!apps/mobile/modules/*/ios/');
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(keep).toBeGreaterThan(drop);
  });
});

describe('toPoseFrame', () => {
  it('keeps a well-formed frame', () => {
    const k = person();
    expect(toPoseFrame({ t: 12.5, w: 720, h: 1280, fps: 29.8, people: [{ k }] })).toEqual({
      t: 12.5,
      w: 720,
      h: 1280,
      fps: 29.8,
      people: [{ k }],
    });
  });

  it('drops malformed people and clamps values to [0, 1]', () => {
    const k = person();
    k[0] = 1.2;
    k[1] = -0.1;
    const frame = toPoseFrame({
      t: 0,
      w: 720,
      h: 1280,
      fps: 30,
      people: [{ k }, { k: [1, 2, 3] }, { k: person(Number.NaN) }, null, 'x'],
    });
    expect(frame?.people).toHaveLength(1);
    expect(frame?.people[0]?.k[0]).toBe(1);
    expect(frame?.people[0]?.k[1]).toBe(0);
  });

  it('rejects frames without a time, a size or a people list', () => {
    expect(toPoseFrame(null)).toBeNull();
    expect(toPoseFrame({ t: 'x', w: 720, h: 1280, people: [] })).toBeNull();
    expect(toPoseFrame({ t: 0, w: 0, h: 1280, people: [] })).toBeNull();
    expect(toPoseFrame({ t: 0, w: 720, h: 1280 })).toBeNull();
  });

  it('keeps the session clock when present', () => {
    expect(toPoseFrame({ t: 5, ts: 4005, w: 720, h: 1280, fps: 30, people: [] })?.ts).toBe(4005);
    const bad = toPoseFrame({ t: 5, ts: 'x', w: 720, h: 1280, fps: 30, people: [] });
    expect(bad).not.toHaveProperty('ts');
  });

  it('defaults a missing or bad fps to 0', () => {
    expect(toPoseFrame({ t: 0, w: 720, h: 1280, people: [] })?.fps).toBe(0);
    expect(toPoseFrame({ t: 0, w: 720, h: 1280, fps: -1, people: [] })?.fps).toBe(0);
  });
});

describe('keypoint helpers', () => {
  it('toKeypoints wants exactly 57 finite numbers', () => {
    expect(toKeypoints(person())).toHaveLength(57);
    expect(toKeypoints(person().slice(1))).toBeNull();
    expect(toKeypoints('nope')).toBeNull();
  });

  it('joint reads [x, y, c] and treats c = 0 as missing', () => {
    const k = person(0);
    const i = JOINT_ORDER.indexOf('leftWrist') * 3;
    k[i] = 0.25;
    k[i + 1] = 0.75;
    k[i + 2] = 0.9;
    expect(joint(k, 'leftWrist')).toEqual([0.25, 0.75, 0.9]);
    expect(joint(k, 'nose')).toBeNull();
  });
});

describe('toStatusEvent', () => {
  it('accepts the five states', () => {
    for (const state of ['starting', 'running', 'recording', 'error', 'no_camera'] as const) {
      expect(toStatusEvent({ state })).toEqual({ state });
    }
    expect(toStatusEvent({ state: 'error', message: 'Camera interrupted' })).toEqual({
      state: 'error',
      message: 'Camera interrupted',
    });
  });

  it('rejects anything else', () => {
    expect(toStatusEvent({ state: 'paused' })).toBeNull();
    expect(toStatusEvent(undefined)).toBeNull();
  });
});

describe('toStopRoundResult', () => {
  const snap = (t_ms: number, extra: Record<string, unknown> = {}) => ({
    t_ms,
    uri: `file:///caches/dance-pose/snap-${t_ms}.jpg`,
    width: 288,
    height: 512,
    bytes: 40_000,
    sha256: SHA,
    ...extra,
  });

  it('keeps a clip with its hash and sorts the snapshots', () => {
    const r = toStopRoundResult({
      clipUri: 'file:///caches/dance-pose/round-1.mp4',
      clipSha256: SHA,
      snapshots: [snap(9000), snap(1000.4)],
    });
    expect(r.clipUri).toBe('file:///caches/dance-pose/round-1.mp4');
    expect(r.clipSha256).toBe(SHA);
    expect(r.snapshots.map((s) => s.t_ms)).toEqual([1000, 9000]);
  });

  it('reports no clip when the uri or the hash is missing or malformed', () => {
    expect(toStopRoundResult({ clipUri: null, clipSha256: SHA, snapshots: [] }).clipUri).toBeNull();
    const badHash = { clipUri: 'file:///x.mp4', clipSha256: 'AB', snapshots: [] };
    expect(toStopRoundResult(badHash)).toEqual(emptyStopResult());
    expect(toStopRoundResult('nope')).toEqual(emptyStopResult());
  });

  it('drops snapshots over the size limits or with a bad hash or uri', () => {
    const r = toStopRoundResult({
      clipUri: null,
      clipSha256: null,
      snapshots: [
        snap(1000),
        snap(2000, { bytes: 200_001 }),
        snap(3000, { width: 720, height: 1280 }),
        snap(4000, { sha256: 'xyz' }),
        snap(5000, { uri: 'https://example.com/a.jpg' }),
      ],
    });
    expect(r.snapshots.map((s) => s.t_ms)).toEqual([1000]);
  });
});

describe('clampMaxFps', () => {
  it('defaults to 30 and stays within 1..60', () => {
    expect(clampMaxFps(undefined)).toBe(DEFAULT_MAX_FPS);
    expect(clampMaxFps(Number.NaN)).toBe(DEFAULT_MAX_FPS);
    expect(clampMaxFps(0)).toBe(1);
    expect(clampMaxFps(120)).toBe(60);
    expect(clampMaxFps(15)).toBe(15);
  });
});

describe('toStillResult', () => {
  it('passes a well-formed still and refuses anything else', () => {
    const ok = { ok: true, uri: 'file:///c/still-1.jpg', width: 720, height: 1280, ts: 1234.5 };
    expect(toStillResult(ok)).toEqual(ok);
    expect(toStillResult({ ok: false, message: 'camera is not running' })).toEqual({
      ok: false,
      message: 'camera is not running',
    });
    expect(toStillResult(null)).toEqual({ ok: false });
    expect(toStillResult({ ...ok, uri: 'https://x/y.jpg' })).toEqual({ ok: false });
    expect(toStillResult({ ...ok, width: 0 })).toEqual({ ok: false });
    expect(toStillResult({ ...ok, height: 4000 })).toEqual({ ok: false });
    expect(toStillResult({ ...ok, ts: 'soon' })).toEqual({ ok: false });
  });
});
