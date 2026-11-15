import 'package:flutter/material.dart';

import '../../api/models/calibration.dart';
import '../../capture/cover_transform.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/text.dart';

/// A labelled box drawn over the viewfinder.
class OverlayBox {
  const OverlayBox({required this.entity, required this.label, required this.bbox, this.conf, this.opening});
  final String entity;
  final String label;
  final List<int> bbox;
  final int? conf; // percent
  final List<int>? opening; // derived `.opening` band, if the program uses it
}

/// Entity boxes, placed regions and the in-progress placement, drawn in
/// image coordinates through the preview's cover transform.
class SceneOverlay extends StatelessWidget {
  const SceneOverlay({
    super.key,
    required this.transform,
    required this.boxes,
    required this.regions,
    required this.pending,
    this.onLabelTap,
  });

  final CoverTransform transform;
  final List<OverlayBox> boxes;
  final List<Region> regions;
  final List<List<int>> pending;
  final ValueChanged<String>? onLabelTap;

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        IgnorePointer(
          child: CustomPaint(
            painter: _ScenePainter(transform: transform, boxes: boxes, regions: regions, pending: pending),
          ),
        ),
        for (final b in boxes) _label(b),
      ],
    );
  }

  Widget _label(OverlayBox b) {
    final r = transform.rectToBox(b.bbox);
    final top = (r.top - Space.x3).clamp(0.0, transform.box.height - Space.x3);
    final left = r.left.clamp(0.0, transform.box.width - Space.x6);
    return Positioned(
      left: left,
      top: top,
      child: GestureDetector(
        key: ValueKey('entity-label-${b.entity}'),
        behavior: HitTestBehavior.opaque,
        onTap: onLabelTap == null ? null : () => onLabelTap!(b.entity),
        child: Container(
          height: Space.x3,
          padding: const EdgeInsets.symmetric(horizontal: Space.x1),
          alignment: Alignment.center,
          decoration: const BoxDecoration(
            color: Palette.background,
            borderRadius: BorderRadius.all(Radius.circular(4)),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            DataText(b.label, style: Typo.small.copyWith(color: Palette.text)),
            if (b.conf != null) ...[
              const SizedBox(width: Space.x1 / 2),
              DataText('${b.conf}%', style: Typo.small),
            ],
          ]),
        ),
      ),
    );
  }
}

class _ScenePainter extends CustomPainter {
  _ScenePainter({required this.transform, required this.boxes, required this.regions, required this.pending});

  final CoverTransform transform;
  final List<OverlayBox> boxes;
  final List<Region> regions;
  final List<List<int>> pending;

  static final Paint _box = Paint()
    ..style = PaintingStyle.stroke
    ..strokeWidth = 1
    ..color = Palette.text.withValues(alpha: 0.8);
  static final Paint _band = Paint()
    ..style = PaintingStyle.stroke
    ..strokeWidth = 1
    ..color = Palette.secondary;
  static final Paint _region = Paint()
    ..style = PaintingStyle.stroke
    ..strokeWidth = 2
    ..color = Palette.text;
  static final Paint _dot = Paint()..color = Palette.text;

  @override
  void paint(Canvas canvas, Size size) {
    for (final b in boxes) {
      canvas.drawRect(transform.rectToBox(b.bbox), _box);
      final o = b.opening;
      if (o != null) canvas.drawRect(transform.rectToBox(o), _band);
    }
    for (final r in regions) {
      final pts = [for (final p in r.points) transform.toBox(p)];
      if (r.shape == 'line' && pts.length == 2) {
        canvas.drawLine(pts[0], pts[1], _region);
        // Mark the behind side with a short tick from the midpoint.
        final mid = Offset((pts[0].dx + pts[1].dx) / 2, (pts[0].dy + pts[1].dy) / 2);
        final d = pts[1] - pts[0];
        final len = d.distance;
        if (len > 0) {
          // Image y grows downward, as on screen, so the normal that makes
          // cross((b−a),(n)) positive is (−dy, dx).
          final n = Offset(-d.dy, d.dx) / len * (r.behindSign ?? 1).toDouble() * Space.x2;
          canvas.drawLine(mid, mid + n, _region);
        }
      } else if (pts.length >= 3) {
        canvas.drawPath(Path()..addPolygon(pts, true), _region);
      }
    }
    for (var i = 0; i < pending.length; i++) {
      final p = transform.toBox(pending[i]);
      canvas.drawCircle(p, 4, _dot);
      if (i > 0) canvas.drawLine(transform.toBox(pending[i - 1]), p, _region);
    }
  }

  @override
  bool shouldRepaint(_ScenePainter old) =>
      old.boxes != boxes || old.regions != regions || old.pending != pending || old.transform != transform;
}
