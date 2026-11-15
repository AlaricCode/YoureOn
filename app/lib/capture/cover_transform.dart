import 'dart:math' as math;
import 'dart:ui';

/// The `BoxFit.cover` mapping between a preview box on screen and the full
/// captured image (CONTRACTS.md §5.2: calibration coordinates are normalized
/// `0..10000` to the full captured image, so the app inverts the preview's
/// fit/crop transform).
class CoverTransform {
  CoverTransform({required this.box, required this.image})
      : assert(image.width > 0 && image.height > 0),
        scale = math.max(box.width / image.width, box.height / image.height) {
    offset = Offset((box.width - image.width * scale) / 2, (box.height - image.height * scale) / 2);
  }

  /// Size of the preview widget (logical px).
  final Size box;

  /// Upright size of the captured image (px).
  final Size image;

  final double scale;
  late final Offset offset;

  /// Screen point in the box → normalized `[x, y]` (floor, clamped to
  /// `0..10000`). Points in the cropped-away margin clamp to the edge.
  List<int> toImage(Offset local) {
    final x = (local.dx - offset.dx) / (image.width * scale);
    final y = (local.dy - offset.dy) / (image.height * scale);
    return [_norm(x), _norm(y)];
  }

  /// Normalized `[x, y]` → screen point in the box.
  Offset toBox(List<int> p) => Offset(
        offset.dx + p[0] / 10000 * image.width * scale,
        offset.dy + p[1] / 10000 * image.height * scale,
      );

  /// Normalized `[x0, y0, x1, y1]` → screen rect.
  Rect rectToBox(List<int> bbox) =>
      Rect.fromPoints(toBox([bbox[0], bbox[1]]), toBox([bbox[2], bbox[3]]));

  /// Whether a normalized point is visible inside the (cropped) preview.
  bool visible(List<int> p) {
    final o = toBox(p);
    return o.dx >= 0 && o.dy >= 0 && o.dx <= box.width && o.dy <= box.height;
  }

  static int _norm(double v) => (v * 10000).floor().clamp(0, 10000);
}
