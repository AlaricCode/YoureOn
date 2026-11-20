// The Dance Off round uses the selfie camera (model/camera): the phone stands facing the dancers
// with its screen towards them. The poses are never mirrored; the preview is, so what is drawn
// over it flips.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { danceCameraFrom, guideSides, previewMirrored } from '../model/camera';

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
    expect(engine).toContain('position: wanted)');
    expect(engine).toMatch(
      /position: wanted\)\s*\n\s*\?\? AVCaptureDevice\.default\([^)]*position: \.back\)/,
    );
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
