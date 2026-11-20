// The Dance Off round uses the selfie camera (model/camera): the phone stands facing the dancers
// with its screen towards them. The poses are never mirrored; the preview is, so what is drawn
// over it flips.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { danceCameraFrom, guideSides, previewMirrored } from '../model/camera';
import { CAMERA_ASPECT, fitPanels, stagePanelLayout } from '../model/overlay';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(resolve(MOBILE, rel), 'utf8');

describe('the dance camera', () => {
  it('is the selfie camera unless the flag says back', () => {
    expect(danceCameraFrom(undefined)).toBe('front');
    expect(danceCameraFrom('')).toBe('front');
    expect(danceCameraFrom('front')).toBe('front');
    expect(danceCameraFrom('selfie')).toBe('front');
    expect(danceCameraFrom('back')).toBe('back');
    expect(danceCameraFrom(' Back ')).toBe('back');
  });

  it('shows a mirror image only with the selfie camera', () => {
    expect(previewMirrored('front')).toBe(true);
    expect(previewMirrored('back')).toBe(false);
  });

  it('puts A, who is on the left of the IMAGE, on the right of a mirrored screen', () => {
    expect(guideSides(false)).toEqual({ left: 'a', right: 'b' });
    expect(guideSides(true)).toEqual({ left: 'b', right: 'a' });
  });
});

describe('the native camera (source audit: it only runs on a device)', () => {
  const engine = read('modules/dance-pose/ios/DancePoseEngine.swift');

  it('opens the camera the `facing` prop asks for, and falls back to the back one', () => {
    expect(read('modules/dance-pose/ios/DancePoseModule.swift')).toContain('Prop("facing")');
    expect(read('modules/dance-pose/ios/DancePoseView.swift')).toContain(
      'engine.setFacing(front: value == "front")',
    );
    expect(engine).toContain('wantsFront.get() ? .front : .back');
    // the widest front camera first, the back one if there is none
    expect(engine).toContain('.builtInUltraWideCamera, for: .video, position: .front)');
    expect(engine).toContain(
      '?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)',
    );
    // not zoomed in: Center Stage off, the widest format, minimum zoom
    expect(engine).toContain('AVCaptureDevice.isCenterStageEnabled = false');
    expect(engine).toContain('device.videoZoomFactor = device.minAvailableVideoZoomFactor');
  });

  it('never mirrors the frames it scores, records and sends, whichever camera', () => {
    // The scoring and the "A = left in the image" rule depend on it.
    expect(engine).toContain('connection.automaticallyAdjustsVideoMirroring = false');
    expect(engine).toContain('connection.isVideoMirrored = false');
    expect(engine).not.toContain('isVideoMirrored = true');
  });

  it('passes the prop through the JS wrapper, back by default', () => {
    expect(read('modules/dance-pose/src/DancePoseView.tsx')).toContain(
      "facing={facing === 'front' ? 'front' : 'back'}",
    );
  });
});

describe('what is drawn over a mirrored preview (source audit)', () => {
  it('flips the pose layer as one and each piece of text back', () => {
    const stage = read('src/dance/Stage.tsx');
    expect(stage).toContain('mirrored && styles.flipped');
    expect(stage).toContain('flipped={mirrored}');
    const parts = read('src/dance/LiveParts.tsx');
    expect(parts).toContain('flipped && styles.unflip');
    expect(parts).toContain('[{ translateY }, { scaleX: -1 }]');
  });

  it('is used by the round screen: the selfie camera, its mirror flag, the guide', () => {
    const screen = read('src/dance/DanceOffScreen.tsx');
    expect(screen).toContain('facing={DANCE_CAMERA}');
    expect(screen).toContain('previewMirrored(DANCE_CAMERA)');
    expect(screen).toContain('guideSides(mirrored)');
  });
});

// The frames follow how the device is held: upright 720x1280, on its side 1280x720.
describe('recording on its side (landscape)', () => {
  it('lays two upright panels side by side, as before', () => {
    const box = { width: 390, height: 600 };
    const { panel, stacked } = stagePanelLayout(box, CAMERA_ASPECT, 8);
    expect(stacked).toBe(false);
    expect(panel).toEqual(fitPanels(box, CAMERA_ASPECT, 8));
  });

  it('stacks two wide panels on an upright screen, where side by side they would be slivers', () => {
    const { panel, stacked } = stagePanelLayout({ width: 390, height: 600 }, 16 / 9, 8);
    expect(stacked).toBe(true);
    expect(panel.width).toBe(390);
    expect(panel.height * 2 + 8).toBeLessThanOrEqual(600);
  });

  it("keeps the camera's shape either way, and survives an unmeasured box", () => {
    for (const aspect of [9 / 16, 16 / 9]) {
      const { panel } = stagePanelLayout({ width: 1210, height: 700 }, aspect, 8);
      expect(panel.width / panel.height).toBeCloseTo(aspect, 6);
    }
    expect(stagePanelLayout({ width: 0, height: 0 }, 16 / 9, 8).panel).toEqual({
      width: 0,
      height: 0,
    });
  });

  it('turns the frames with the device, but never while a round is recording (source audit)', () => {
    const engine = read('modules/dance-pose/ios/DancePoseEngine.swift');
    expect(engine).toContain(
      'guard configured, !roundActive.get(), let angle = wantedRotation.get()',
    );
    expect(engine).toContain('self.roundActive.set(true)');
    const view = read('modules/dance-pose/ios/DancePoseView.swift');
    expect(view).toContain(
      'AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)',
    );
    expect(view).toContain('videoRotationAngleForHorizonLevelCapture');
    // and the app starts its scoring over at the new size, before the round only
    const pipeline = read('src/dance/model/pipeline.ts');
    expect(pipeline).toContain('if (size && (tracker !== null || offset !== null)) return;');
  });
});
