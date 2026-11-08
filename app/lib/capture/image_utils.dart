import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

/// Upload JPEGs are at most 640 px on the long side (CONTRACTS.md §12.3,
/// §12.4).
const int kUploadLongSide = 640;

class JpegResult {
  const JpegResult(this.jpeg, this.width, this.height);
  final Uint8List jpeg;
  final int width;
  final int height;
}

class _Req {
  const _Req(this.bytes, this.longSide, this.quality, this.crop);
  final Uint8List bytes;
  final int longSide;
  final int quality;
  final List<int>? crop; // normalized [x0,y0,x1,y1]
}

JpegResult _process(_Req r) {
  final decoded = img.decodeImage(r.bytes);
  if (decoded == null) throw const FormatException('not an image');
  var im = img.bakeOrientation(decoded);
  final crop = r.crop;
  if (crop != null) {
    final x0 = (crop[0] * im.width ~/ 10000).clamp(0, im.width - 1);
    final y0 = (crop[1] * im.height ~/ 10000).clamp(0, im.height - 1);
    final x1 = (crop[2] * im.width ~/ 10000).clamp(x0 + 1, im.width);
    final y1 = (crop[3] * im.height ~/ 10000).clamp(y0 + 1, im.height);
    im = img.copyCrop(im, x: x0, y: y0, width: x1 - x0, height: y1 - y0);
  }
  final long = im.width > im.height ? im.width : im.height;
  if (long > r.longSide) {
    im = im.width >= im.height
        ? img.copyResize(im, width: r.longSide, interpolation: img.Interpolation.average)
        : img.copyResize(im, height: r.longSide, interpolation: img.Interpolation.average);
  }
  return JpegResult(Uint8List.fromList(img.encodeJpg(im, quality: r.quality)), im.width, im.height);
}

/// Re-encodes any image as an upright JPEG with long side ≤ [longSide].
Future<JpegResult> toUploadJpeg(Uint8List bytes, {int longSide = kUploadLongSide, int quality = 85}) =>
    compute(_process, _Req(bytes, longSide, quality, null));

/// Crops a normalized bbox out of an image and returns a JPEG.
Future<JpegResult> cropJpeg(Uint8List bytes, List<int> bbox, {int longSide = kUploadLongSide, int quality = 85}) =>
    compute(_process, _Req(bytes, longSide, quality, bbox));

/// Synchronous variant for tests.
JpegResult toUploadJpegSync(Uint8List bytes, {int longSide = kUploadLongSide, List<int>? crop}) =>
    _process(_Req(bytes, longSide, 85, crop));
