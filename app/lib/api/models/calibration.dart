import 'json.dart';

/// Calibration JSON (CONTRACTS.md §5.2). All coordinates are integers
/// `0..10000` normalized to the full captured image.
class CameraPose {
  const CameraPose({required this.pitchCdeg, required this.rollCdeg});
  final int pitchCdeg;
  final int rollCdeg;

  factory CameraPose.fromJson(Object? v) {
    final j = asJson(v);
    return CameraPose(pitchCdeg: asInt(j['pitch_cdeg']), rollCdeg: asInt(j['roll_cdeg']));
  }

  Json toJson() => {'pitch_cdeg': pitchCdeg, 'roll_cdeg': rollCdeg};
}

class CameraInfo {
  const CameraInfo({
    required this.widthPx,
    required this.heightPx,
    required this.orientation,
    this.refFrameSha256,
    this.pose,
  });

  final int widthPx;
  final int heightPx;
  final String orientation; // landscape | portrait
  final String? refFrameSha256;
  final CameraPose? pose;

  factory CameraInfo.fromJson(Object? v) {
    final j = asJson(v);
    return CameraInfo(
      widthPx: asInt(j['width_px']),
      heightPx: asInt(j['height_px']),
      orientation: asString(j['orientation']),
      refFrameSha256: asStringOrNull(j['ref_frame_sha256']),
      pose: j['pose'] == null ? null : CameraPose.fromJson(j['pose']),
    );
  }

  /// Absent optional fields are omitted, never null (§2.7 rule 6 style).
  Json toJson() => {
        'width_px': widthPx,
        'height_px': heightPx,
        'orientation': orientation,
        if (refFrameSha256 != null) 'ref_frame_sha256': refFrameSha256,
        if (pose != null) 'pose': pose!.toJson(),
      };
}

class EntityRef {
  const EntityRef({required this.entity, required this.label, required this.bbox, this.cropSha256});
  final String entity;
  final String label;
  final List<int> bbox; // [x0,y0,x1,y1]
  final String? cropSha256;

  factory EntityRef.fromJson(Object? v) {
    final j = asJson(v);
    return EntityRef(
      entity: asString(j['entity']),
      label: asString(j['label']),
      bbox: asIntList(j['bbox']),
      cropSha256: asStringOrNull(j['crop_sha256']),
    );
  }

  Json toJson() => {
        'entity': entity,
        'label': label,
        'bbox': bbox,
        if (cropSha256 != null) 'crop_sha256': cropSha256,
      };
}

/// A placed region: a line (two points + behind_sign) or a zone (3..8 points).
class Region {
  const Region.line({required this.entity, required this.points, required int this.behindSign})
      : shape = 'line';
  const Region.zone({required this.entity, required this.points})
      : shape = 'zone',
        behindSign = null;

  final String entity;
  final String shape;
  final List<List<int>> points;
  final int? behindSign; // 1 | -1, lines only

  factory Region.fromJson(Object? v) {
    final j = asJson(v);
    final pts = asList(j['points'], asIntList);
    final shape = asString(j['shape']);
    if (shape == 'line') {
      return Region.line(entity: asString(j['entity']), points: pts, behindSign: asInt(j['behind_sign']));
    }
    if (shape == 'zone') return Region.zone(entity: asString(j['entity']), points: pts);
    throw FormatException('unknown region shape', shape);
  }

  Json toJson() => {
        'entity': entity,
        'shape': shape,
        'points': points,
        if (behindSign != null) 'behind_sign': behindSign,
      };

  /// Structural validity per §5.2 (bounds, vertex counts, non-degenerate
  /// lines, nonzero behind_sign).
  bool get valid {
    bool inRange(List<int> p) =>
        p.length == 2 && p.every((c) => c >= 0 && c <= 10000);
    if (!points.every(inRange)) return false;
    if (shape == 'line') {
      if (points.length != 2) return false;
      if (points[0][0] == points[1][0] && points[0][1] == points[1][1]) return false;
      return behindSign == 1 || behindSign == -1;
    }
    return points.length >= 3 && points.length <= 8;
  }
}

class Calibration {
  const Calibration({required this.camera, required this.entityRefs, required this.regions});

  final CameraInfo camera;
  final List<EntityRef> entityRefs;
  final List<Region> regions;

  factory Calibration.fromJson(Object? v) {
    final j = asJson(v, 'Calibration');
    final scene = asJson(j['scene']);
    return Calibration(
      camera: CameraInfo.fromJson(scene['camera']),
      entityRefs: asList(scene['entity_refs'], EntityRef.fromJson),
      regions: asList(j['regions'], Region.fromJson),
    );
  }

  Json toJson() => {
        'version': 1,
        'scene': {
          'camera': camera.toJson(),
          'entity_refs': [for (final e in entityRefs) e.toJson()],
        },
        'regions': [for (final r in regions) r.toJson()],
      };
}

/// `behind_sign = side(L, tap)`: the sign of the 2-D cross product of
/// (b − a) × (tap − a), in normalized image coordinates (§5.2). Returns 0 when
/// the tap is on the line (invalid; the user must tap again).
int lineSide(List<int> a, List<int> b, List<int> tap) {
  final cross = (b[0] - a[0]) * (tap[1] - a[1]) - (b[1] - a[1]) * (tap[0] - a[0]);
  return cross > 0 ? 1 : (cross < 0 ? -1 : 0);
}
