import 'json.dart';

enum ProgramKind {
  rules('rules'),
  aiJudged('ai_judged'),
  market('market');

  const ProgramKind(this.wire);
  final String wire;

  static ProgramKind parse(Object? v) => enumByWire(values, v, (e) => e.wire);
}

/// Entity of a program (CONTRACTS.md §2.6).
class ProgramEntity {
  const ProgramEntity({
    required this.name,
    required this.kind,
    this.participant,
    this.phrase,
    this.shape,
  });

  final String name;
  final String kind; // person | person_any | object | region
  final int? participant;
  final String? phrase;
  final String? shape; // line | zone

  bool get isRegion => kind == 'region';
  bool get isLine => isRegion && shape == 'line';

  factory ProgramEntity.fromJson(Object? v) {
    final j = asJson(v, 'entity');
    return ProgramEntity(
      name: asString(j['name']),
      kind: asString(j['kind']),
      participant: asIntOrNull(j['participant']),
      phrase: asStringOrNull(j['phrase']),
      shape: asStringOrNull(j['shape']),
    );
  }
}

/// The compiled program. The AST is kept verbatim in [json] (it is hashed
/// server-side and never re-serialized by the app); common fields are typed.
class Program {
  const Program({
    required this.json,
    required this.kind,
    required this.participants,
    required this.sides,
    required this.entities,
    required this.timeLimitS,
    this.stakeEach,
    this.stakes,
    this.question,
  });

  final Json json;
  final ProgramKind kind;
  final List<String> participants;
  final List<int> sides;
  final List<ProgramEntity> entities;
  final int timeLimitS;
  final int? stakeEach;
  final List<int>? stakes;
  final String? question;

  List<Json> get legs => asList(json['legs'], (e) => asJson(e));

  List<ProgramEntity> get regions => entities.where((e) => e.isRegion).toList();

  factory Program.fromJson(Object? v) {
    final j = asJson(v, 'Program');
    return Program(
      json: j,
      kind: ProgramKind.parse(j['kind']),
      participants: asStringList(j['participants']),
      sides: asIntList(j['sides']),
      entities: asList(j['entities'], ProgramEntity.fromJson),
      timeLimitS: asInt(j['time_limit_s']),
      stakeEach: asIntOrNull(j['stake_each']),
      stakes: j['stakes'] == null ? null : asIntList(j['stakes']),
      question: asStringOrNull(j['question']),
    );
  }
}

/// `CompileError` (§2.7).
class CompileError {
  const CompileError({required this.path, required this.code, required this.message, this.col});
  final String path;
  final String code;
  final String message;
  final int? col;

  factory CompileError.fromJson(Object? v) {
    final j = asJson(v);
    return CompileError(
      path: asString(j['path']),
      code: asString(j['code']),
      message: asString(j['message']),
      col: asIntOrNull(j['col']),
    );
  }
}
