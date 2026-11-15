import '../api/models/calibration.dart';
import '../api/models/program.dart';
import '../evidence/chunk_uploader.dart';

/// What the next tap does during placement.
enum PlacementStep {
  idle,
  lineStart,
  lineEnd,
  lineSide,
  zoneCorners,
  labelTarget;

  /// The 1–3 word prompt shown over the viewfinder.
  String? get prompt => switch (this) {
        idle => null,
        lineStart => 'Line start',
        lineEnd => 'Line end',
        lineSide => 'Standing side',
        zoneCorners => 'Zone corners',
        labelTarget => 'Tap object',
      };
}

/// Region placement and label correction on the Scene check viewfinder
/// (CONTRACTS.md §5.2):
/// - a line takes two taps, then one tap on the side where the actor must
///   stand (`behind_sign = side(L, tap)`, nonzero; degenerate lines are
///   rejected);
/// - a zone takes 3–8 corner taps, finished with Done (auto at 8);
/// - label correction: tap the label, then the object.
class Placement {
  String? _entity;
  String? _shape;
  final List<List<int>> _points = [];
  PlacementStep _step = PlacementStep.idle;
  final Map<String, Region> regions = {};

  PlacementStep get step => _step;
  String? get entity => _entity;
  List<List<int>> get pending => List.unmodifiable(_points);
  bool get active => _step != PlacementStep.idle;
  bool get canFinishZone => _step == PlacementStep.zoneCorners && _points.length >= 3;

  void beginRegion(ProgramEntity e) {
    if (!e.isRegion) throw ArgumentError('not a region entity');
    _entity = e.name;
    _shape = e.shape == 'line' ? 'line' : 'zone';
    _points.clear();
    _step = _shape == 'line' ? PlacementStep.lineStart : PlacementStep.zoneCorners;
  }

  void beginLabel(String entity) {
    _entity = entity;
    _shape = null;
    _points.clear();
    _step = PlacementStep.labelTarget;
  }

  void cancel() {
    _entity = null;
    _shape = null;
    _points.clear();
    _step = PlacementStep.idle;
  }

  /// Applies one tap (normalized image point). Returns the region when this
  /// tap completed one, else null. For [PlacementStep.labelTarget] the
  /// caller handles the point via [takeLabelTarget].
  Region? tap(List<int> p) {
    switch (_step) {
      case PlacementStep.idle:
      case PlacementStep.labelTarget:
        return null;
      case PlacementStep.lineStart:
        _points
          ..clear()
          ..add(p);
        _step = PlacementStep.lineEnd;
        return null;
      case PlacementStep.lineEnd:
        if (p[0] == _points[0][0] && p[1] == _points[0][1]) return null; // degenerate
        _points.add(p);
        _step = PlacementStep.lineSide;
        return null;
      case PlacementStep.lineSide:
        final sign = lineSide(_points[0], _points[1], p);
        if (sign == 0) return null; // on the line: tap again
        final r = Region.line(entity: _entity!, points: [_points[0], _points[1]], behindSign: sign);
        return _commit(r);
      case PlacementStep.zoneCorners:
        _points.add(p);
        if (_points.length >= 8) return finishZone();
        return null;
    }
  }

  /// Completes a zone with the corners tapped so far (≥ 3).
  Region? finishZone() {
    if (!canFinishZone) return null;
    return _commit(Region.zone(entity: _entity!, points: List.of(_points)));
  }

  /// Ends a label correction; returns the entity being corrected.
  String? takeLabelTarget() {
    if (_step != PlacementStep.labelTarget) return null;
    final e = _entity;
    cancel();
    return e;
  }

  Region _commit(Region r) {
    regions[r.entity] = r;
    cancel();
    return r;
  }
}

/// A box around a tapped point when the tapped object was not detected:
/// 10% of the frame on each side, clamped.
List<int> boxAround(List<int> p, {int half = 1000}) {
  int c(int v) => v.clamp(0, 10000);
  return [c(p[0] - half), c(p[1] - half), c(p[0] + half), c(p[1] + half)];
}

bool boxContains(List<int> b, List<int> p) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/// The smallest box among [boxes] that contains [p], or null.
List<int>? smallestContaining(Iterable<List<int>> boxes, List<int> p) {
  List<int>? best;
  int? bestArea;
  for (final b in boxes) {
    if (!boxContains(b, p)) continue;
    final a = (b[2] - b[0]) * (b[3] - b[1]);
    if (bestArea == null || a < bestArea) {
      best = b;
      bestArea = a;
    }
  }
  return best;
}

/// Everything the creator has set on Scene check, turned into the §5.2
/// calibration JSON.
class CalibrationDraft {
  CalibrationDraft({required this.camera});

  CameraMeta camera;
  String? refFrameSha256;
  CameraPose? pose;

  /// Detected or corrected entity references, by entity name.
  final Map<String, EntityRef> refs = {};

  /// Entities whose bbox the user set (detections no longer override them).
  final Set<String> corrected = {};

  /// Region entities of [program] that still need a region.
  List<ProgramEntity> missingRegions(Program program, Map<String, Region> regions) =>
      [for (final e in program.regions) if (!(regions[e.name]?.valid ?? false)) e];

  bool complete(Program program, Map<String, Region> regions) => missingRegions(program, regions).isEmpty;

  /// Applies a detection unless the user corrected that entity.
  void detected(String entity, String label, List<int> bbox) {
    if (corrected.contains(entity)) return;
    final old = refs[entity];
    final same = old != null && _eq(old.bbox, bbox);
    refs[entity] = EntityRef(entity: entity, label: label, bbox: bbox, cropSha256: same ? old.cropSha256 : null);
  }

  void correct(String entity, String label, List<int> bbox, {String? cropSha256}) {
    corrected.add(entity);
    refs[entity] = EntityRef(entity: entity, label: label, bbox: bbox, cropSha256: cropSha256);
  }

  void setCrop(String entity, String sha) {
    final r = refs[entity];
    if (r == null) return;
    refs[entity] = EntityRef(entity: r.entity, label: r.label, bbox: r.bbox, cropSha256: sha);
  }

  /// Entity refs in program entity order (non-region entities only), then
  /// regions in program entity order.
  Calibration build(Program program, Map<String, Region> regions) => Calibration(
        camera: CameraInfo(
          widthPx: camera.widthPx,
          heightPx: camera.heightPx,
          orientation: camera.orientation,
          refFrameSha256: refFrameSha256,
          pose: pose,
        ),
        entityRefs: [
          for (final e in program.entities)
            if (!e.isRegion && refs[e.name] != null) refs[e.name]!,
        ],
        regions: [
          for (final e in program.regions)
            if (regions[e.name] != null) regions[e.name]!,
        ],
      );

  static bool _eq(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}

/// Whether two calibrations would hash differently (cheap structural
/// comparison of their JSON).
bool sameCalibration(Calibration? a, Calibration? b) {
  if (a == null || b == null) return a == b;
  return a.toJson().toString() == b.toJson().toString();
}
