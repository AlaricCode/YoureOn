import 'dart:typed_data';

import 'package:image/image.dart' as img;

/// Pixel layouts delivered by the camera image stream.
enum RawFormat { yuv420, nv21, bgra8888 }

/// A copied camera-stream frame (plane buffers are reused by the plugin, so
/// they are copied before leaving the callback).
class RawFrame {
  const RawFrame({
    required this.width,
    required this.height,
    required this.format,
    required this.planes,
    required this.rowStrides,
    required this.pixelStrides,
    this.rotation = 0,
  });

  final int width;
  final int height;
  final RawFormat format;
  final List<Uint8List> planes;
  final List<int> rowStrides;
  final List<int> pixelStrides;

  /// Clockwise rotation (0/90/180/270) that makes the frame upright.
  final int rotation;
}

int _clamp8(double v) => v < 0 ? 0 : (v > 255 ? 255 : v.round());

/// Converts a raw frame to an upright RGB image whose long side is at most
/// [longSide] (nearest-neighbour subsampling; scene frames are ≤ 640 px,
/// CONTRACTS.md §12.4).
img.Image rawToImage(RawFrame f, {int longSide = 640}) {
  final long = f.width > f.height ? f.width : f.height;
  final step = long <= longSide ? 1 : (long + longSide - 1) ~/ longSide;
  final ow = f.width ~/ step;
  final oh = f.height ~/ step;
  final out = img.Image(width: ow, height: oh);

  switch (f.format) {
    case RawFormat.bgra8888:
      final p = f.planes[0];
      final rs = f.rowStrides[0];
      for (var y = 0; y < oh; y++) {
        final sy = y * step;
        for (var x = 0; x < ow; x++) {
          final i = sy * rs + x * step * 4;
          out.setPixelRgb(x, y, p[i + 2], p[i + 1], p[i]);
        }
      }
    case RawFormat.yuv420:
    case RawFormat.nv21:
      final yp = f.planes[0];
      final yrs = f.rowStrides[0];
      // NV21 may arrive as one buffer (Y then interleaved VU) or two planes.
      late final Uint8List vu;
      late final int vuRs;
      late final int vuOffset;
      if (f.format == RawFormat.nv21) {
        if (f.planes.length >= 2) {
          vu = f.planes[1];
          vuRs = f.rowStrides[1];
          vuOffset = 0;
        } else {
          vu = yp;
          vuRs = yrs;
          vuOffset = yrs * f.height;
        }
      }
      for (var y = 0; y < oh; y++) {
        final sy = y * step;
        for (var x = 0; x < ow; x++) {
          final sx = x * step;
          final yy = yp[sy * yrs + sx].toDouble();
          int u;
          int v;
          if (f.format == RawFormat.yuv420) {
            final ups = f.pixelStrides[1];
            final ui = (sy >> 1) * f.rowStrides[1] + (sx >> 1) * ups;
            final vi = (sy >> 1) * f.rowStrides[2] + (sx >> 1) * f.pixelStrides[2];
            u = f.planes[1][ui];
            v = f.planes[2][vi];
          } else {
            final i = vuOffset + (sy >> 1) * vuRs + (sx >> 1) * 2;
            v = vu[i];
            u = vu[i + 1];
          }
          final du = u - 128;
          final dv = v - 128;
          out.setPixelRgb(
            x,
            y,
            _clamp8(yy + 1.402 * dv),
            _clamp8(yy - 0.344136 * du - 0.714136 * dv),
            _clamp8(yy + 1.772 * du),
          );
        }
      }
  }
  final r = f.rotation % 360;
  return r == 0 ? out : img.copyRotate(out, angle: r);
}

/// Upright JPEG of a raw frame. Pure; run it in an isolate.
Uint8List rawToJpeg(RawFrame f, {int longSide = 640, int quality = 80}) =>
    Uint8List.fromList(img.encodeJpg(rawToImage(f, longSide: longSide), quality: quality));

/// The clockwise rotation that makes a `width × height` frame match the
/// wanted orientation, given the sensor orientation.
int uprightRotation({required int width, required int height, required bool portrait, required int sensorDegrees}) {
  final framePortrait = height > width;
  if (framePortrait == portrait) return 0;
  final s = sensorDegrees % 360;
  return (s == 90 || s == 270) ? s : 90;
}
