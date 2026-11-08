import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:verdict/api/models/calibration.dart';
import 'package:verdict/capture/cover_transform.dart';
import 'package:verdict/capture/frame_convert.dart';
import 'package:verdict/capture/pose.dart';

void main() {
  group('CoverTransform', () {
    test('inverts a cover fit that crops the sides', () {
      // 720×1280 image in a 300×300 box: scale = 300/720, image height
      // 533.33 → 116.67 px cropped top and bottom.
      final t = CoverTransform(box: const Size(300, 300), image: const Size(720, 1280));
      expect(t.scale, closeTo(300 / 720, 1e-9));
      expect(t.toImage(const Offset(150, 150)), [5000, 5000]);
      expect(t.toImage(const Offset(0, 0)), [0, 2187]); // floor(116.67/533.33·10000)
      expect(t.toImage(const Offset(300, 300)), [10000, 7812]);
      final back = t.toBox([5000, 5000]);
      expect(back.dx, closeTo(150, 1e-9));
      expect(back.dy, closeTo(150, 1e-9));
      expect(t.visible([5000, 1000]), isFalse);
      expect(t.visible([5000, 5000]), isTrue);
    });

    test('round-trips points and clamps outside taps', () {
      final t = CoverTransform(box: const Size(390, 520), image: const Size(1080, 1920));
      for (final p in const [
        [1234, 4321],
        [9999, 5000],
        [5000, 7000],
      ]) {
        final o = t.toBox(p);
        final q = t.toImage(o);
        expect((q[0] - p[0]).abs(), lessThanOrEqualTo(1));
        expect((q[1] - p[1]).abs(), lessThanOrEqualTo(1));
      }
      expect(t.toImage(const Offset(-50, -50)), [0, anything]);
      final r = t.rectToBox([0, 5000, 10000, 5000]);
      expect(r.width, closeTo(390, 1e-6));
    });
  });

  group('pose', () {
    test('gravity → pitch/roll in centi-degrees', () {
      expect(poseFromGravity(0, 9.81, 0).pitchCdeg, 0);
      expect(poseFromGravity(0, 9.81, 0).rollCdeg, 0);
      final tilted = poseFromGravity(0, 9.81, 9.81);
      expect(tilted.pitchCdeg, 4500);
      expect(poseFromGravity(9.81, 9.81, 0).rollCdeg, 4500);
    });

    test('drift and "Camera moved" (> CAMERA_POSE_DRIFT_CDEG)', () {
      const a = CameraPose(pitchCdeg: 100, rollCdeg: 17900);
      const b = CameraPose(pitchCdeg: 250, rollCdeg: -17950);
      expect(poseDriftCdeg(a, b), 150, reason: 'roll wraps at ±180°');
      expect(cameraMoved(a, b), isFalse);
      expect(cameraMoved(a, const CameraPose(pitchCdeg: 401, rollCdeg: 17900)), isTrue);
      expect(cameraMoved(a, const CameraPose(pitchCdeg: 400, rollCdeg: 17900)), isFalse);
      expect(cameraMoved(null, b), isFalse);
      expect(cameraMoved(a, null), isFalse);
    });
  });

  group('frame conversion', () {
    test('BGRA frame → upright JPEG-ready image with subsampling', () {
      const w = 8, h = 4;
      final px = Uint8List(w * h * 4);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          final i = (y * w + x) * 4;
          px[i] = 10; // b
          px[i + 1] = 20; // g
          px[i + 2] = x < w / 2 ? 200 : 0; // r
          px[i + 3] = 255;
        }
      }
      final f = RawFrame(
        width: w,
        height: h,
        format: RawFormat.bgra8888,
        planes: [px],
        rowStrides: const [w * 4],
        pixelStrides: const [4],
      );
      final im = rawToImage(f, longSide: 4);
      expect(im.width, 4);
      expect(im.height, 2);
      expect(im.getPixel(0, 0).r, 200);
      expect(im.getPixel(3, 0).r, 0);
      expect(im.getPixel(0, 0).b, 10);

      final rotated = rawToImage(RawFrame(
        width: w,
        height: h,
        format: RawFormat.bgra8888,
        planes: [px],
        rowStrides: const [w * 4],
        pixelStrides: const [4],
        rotation: 90,
      ));
      expect(rotated.width, h);
      expect(rotated.height, w);
      // Clockwise: the left (red) half becomes the top.
      expect(rotated.getPixel(0, 0).r, 200);
      expect(rotated.getPixel(0, w - 1).r, 0);
      expect(img.decodeJpg(rawToJpeg(f)), isNotNull);
    });

    test('YUV420 (3 planes) and NV21 (1 buffer) decode to the same gray', () {
      const w = 4, h = 4;
      final y = Uint8List(w * h)..fillRange(0, w * h, 128);
      final u = Uint8List(w * h ~/ 4)..fillRange(0, w * h ~/ 4, 128);
      final v = Uint8List(w * h ~/ 4)..fillRange(0, w * h ~/ 4, 128);
      final yuv = rawToImage(RawFrame(
        width: w,
        height: h,
        format: RawFormat.yuv420,
        planes: [y, u, v],
        rowStrides: const [w, w ~/ 2, w ~/ 2],
        pixelStrides: const [1, 1, 1],
      ));
      final nv = Uint8List(w * h * 3 ~/ 2)..fillRange(0, w * h * 3 ~/ 2, 128);
      final nv21 = rawToImage(RawFrame(
        width: w,
        height: h,
        format: RawFormat.nv21,
        planes: [nv],
        rowStrides: const [w],
        pixelStrides: const [1],
      ));
      for (final im in [yuv, nv21]) {
        final p = im.getPixel(1, 1);
        expect([p.r, p.g, p.b], [128, 128, 128]);
      }
    });

    test('upright rotation follows the wanted orientation', () {
      expect(uprightRotation(width: 1280, height: 720, portrait: true, sensorDegrees: 90), 90);
      expect(uprightRotation(width: 1280, height: 720, portrait: true, sensorDegrees: 270), 270);
      expect(uprightRotation(width: 720, height: 1280, portrait: true, sensorDegrees: 90), 0);
      expect(uprightRotation(width: 1280, height: 720, portrait: false, sensorDegrees: 90), 0);
    });
  });
}
