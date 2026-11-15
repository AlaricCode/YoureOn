import 'json.dart';

/// A detected entity in a scene frame (CONTRACTS.md §12.3/§12.4).
class SceneEntity {
  const SceneEntity({required this.entity, required this.label, required this.bbox, required this.conf});
  final String entity;
  final String label;
  final List<int> bbox; // normalized 0..10000
  final int conf; // percent

  factory SceneEntity.fromJson(Object? v) {
    final j = asJson(v);
    return SceneEntity(
      entity: asString(j['entity']),
      label: asString(j['label']),
      bbox: asIntList(j['bbox']),
      conf: asInt(j['conf']),
    );
  }
}

/// A live condition row (§12.10): `{leg, field, path, label, state, placed}`.
class ConditionState {
  const ConditionState({
    required this.leg,
    required this.field,
    required this.path,
    required this.label,
    required this.state,
    required this.placed,
  });

  final int leg;
  final String field;
  final String path;
  final String label;
  final bool state;
  final bool placed;

  String get key => '$leg/$field/$path';

  factory ConditionState.fromJson(Object? v) {
    final j = asJson(v);
    return ConditionState(
      leg: asInt(j['leg']),
      field: asString(j['field']),
      path: asString(j['path']),
      label: asString(j['label']),
      state: asBool(j['state']),
      placed: asBool(j['placed']),
    );
  }
}

/// `POST /bets/:id/scene/detect` response and WS `scene` payload.
class SceneUpdate {
  const SceneUpdate({required this.entities, required this.conditions});
  final List<SceneEntity> entities;
  final List<ConditionState> conditions;

  factory SceneUpdate.fromJson(Object? v) {
    final j = asJson(v);
    return SceneUpdate(
      entities: asList(j['entities'], SceneEntity.fromJson),
      conditions: asList(j['conditions'], ConditionState.fromJson),
    );
  }
}

/// `POST /bets/:id/practice` row.
class PracticeCondition {
  const PracticeCondition({
    required this.leg,
    required this.field,
    required this.path,
    required this.label,
    required this.fired,
    required this.frame,
  });

  final int leg;
  final String field;
  final String path;
  final String label;
  final bool fired;
  final int? frame;

  factory PracticeCondition.fromJson(Object? v) {
    final j = asJson(v);
    return PracticeCondition(
      leg: asInt(j['leg']),
      field: asString(j['field']),
      path: asString(j['path']),
      label: asString(j['label']),
      fired: asBool(j['fired']),
      frame: asIntOrNull(j['frame']),
    );
  }
}

/// `{calibration, calibration_hash}` from `PUT /bets/:id/calibration`.
class CalibrationSaved {
  const CalibrationSaved({required this.calibration, required this.calibrationHash});
  final Json calibration;
  final String calibrationHash;

  factory CalibrationSaved.fromJson(Object? v) {
    final j = asJson(v);
    return CalibrationSaved(
      calibration: asJson(j['calibration']),
      calibrationHash: asString(j['calibration_hash']),
    );
  }
}
