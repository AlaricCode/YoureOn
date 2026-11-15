/// Small, strict JSON readers. A shape mismatch throws [FormatException],
/// which the API client reports as `INTERNAL` ("Server error").
typedef Json = Map<String, dynamic>;

Json asJson(Object? v, [String what = 'object']) {
  if (v is Map<String, dynamic>) return v;
  if (v is Map) return v.cast<String, dynamic>();
  throw FormatException('expected $what, got ${v.runtimeType}');
}

int asInt(Object? v, [String what = 'int']) {
  if (v is int) return v;
  if (v is num && v == v.truncate()) return v.toInt();
  if (v is String) {
    final p = int.tryParse(v);
    if (p != null) return p;
  }
  throw FormatException('expected $what, got $v');
}

int? asIntOrNull(Object? v) => v == null ? null : asInt(v);

String asString(Object? v, [String what = 'string']) {
  if (v is String) return v;
  throw FormatException('expected $what, got $v');
}

String? asStringOrNull(Object? v) => v == null ? null : asString(v);

bool asBool(Object? v, [String what = 'bool']) {
  if (v is bool) return v;
  throw FormatException('expected $what, got $v');
}

List<T> asList<T>(Object? v, T Function(Object? e) f) {
  if (v == null) return <T>[];
  if (v is List) return v.map(f).toList(growable: false);
  throw FormatException('expected list, got ${v.runtimeType}');
}

List<int> asIntList(Object? v) => asList(v, asInt);
List<String> asStringList(Object? v) => asList(v, asString);

Map<String, String> asStringMap(Object? v) {
  if (v == null) return const {};
  return asJson(v).map((k, e) => MapEntry(k, asString(e)));
}

Map<String, int> asIntMap(Object? v) {
  if (v == null) return const {};
  return asJson(v).map((k, e) => MapEntry(k, asInt(e)));
}

T enumByWire<T extends Enum>(List<T> values, Object? v, String Function(T) wire) {
  final s = asString(v);
  for (final e in values) {
    if (wire(e) == s) return e;
  }
  throw FormatException('unknown value', s);
}
