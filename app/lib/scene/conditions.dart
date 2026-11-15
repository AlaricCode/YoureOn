import '../api/models/bet.dart';
import '../api/models/json.dart';
import '../api/models/program.dart';
import '../api/models/scene.dart';
import '../contracts/constants.dart';

/// Event (pulse) primitives (CONTRACTS.md §3.5). Their rows latch true for
/// `PULSE_LATCH_FRAMES` in the live and practice views (§12.10).
const Set<String> kEventOps = {'enters', 'leaves', 'touches', 'crosses', 'released_by', 'disappears_into'};

/// How long an event row stays lit after a pulse.
const int kLatchMs = PULSE_LATCH_FRAMES * 1000 ~/ FPS;

/// The expression node at a condition row's [path] ("0.1" = child indices
/// from the root, "" = the root) in leg [legId]'s [field]. Children follow
/// the AST field order: `args[0], args[1]` / `arg` / `first, then`.
Json? exprAt(Program program, int legId, String field, String path) {
  Json? node;
  for (final leg in program.legs) {
    if (leg['id'] == legId) {
      final f = leg[field];
      if (f is Map) node = Map<String, Object?>.from(f);
      break;
    }
  }
  if (node == null) return null;
  if (path.isEmpty) return node;
  for (final part in path.split('.')) {
    final i = int.tryParse(part);
    if (i == null || node == null) return null;
    node = _child(node, i);
  }
  return node;
}

Json? _child(Json node, int i) {
  Object? c;
  switch (node['op']) {
    case 'and':
    case 'or':
      final args = node['args'];
      if (args is List && i < args.length) c = args[i];
    case 'not':
    case 'for_duration':
    case 'before':
      if (i == 0) c = node['arg'];
    case 'then_within':
      c = i == 0 ? node['first'] : (i == 1 ? node['then'] : null);
    default:
      c = null;
  }
  return c is Map ? Map<String, Object?>.from(c) : null;
}

/// Whether a row is an event (pulse) row.
bool isEventRow(Program program, int leg, String field, String path) {
  final op = exprAt(program, leg, field, path)?['op'];
  return op is String && kEventOps.contains(op);
}

/// Entity names referenced (as `a` or `b`) anywhere under [node].
Set<String> exprEntities(Json node) {
  final out = <String>{};
  void walk(Object? n) {
    if (n is Map) {
      for (final k in const ['a', 'b']) {
        final r = n[k];
        if (r is Map && r['e'] is String) out.add(r['e'] as String);
      }
      for (final k in const ['arg', 'first', 'then']) {
        walk(n[k]);
      }
      final args = n['args'];
      if (args is List) args.forEach(walk);
    }
  }

  walk(node);
  return out;
}

/// Object entities used with a `.opening` sub-region anywhere in the
/// program (openings are derived, never tapped, [D-2]).
Set<String> openingEntities(Program program) {
  final out = <String>{};
  void walk(Object? n) {
    if (n is Map) {
      final b = n['b'];
      if (b is Map && b['sub'] == 'opening' && b['e'] is String) out.add(b['e'] as String);
      for (final k in const ['arg', 'first', 'then', 'valid_attempt', 'success']) {
        walk(n[k]);
      }
      final args = n['args'];
      if (args is List) args.forEach(walk);
    }
  }

  program.legs.forEach(walk);
  return out;
}

/// `.opening` of an object box (§2.3): a band straddling the rim.
List<int> openingRect(List<int> b) {
  final w = b[2] - b[0];
  final h = b[3] - b[1];
  final top = b[1] - h ~/ 10;
  return [b[0] + w ~/ 10, top < 0 ? 0 : top, b[2] - w ~/ 10, b[1] + h ~/ 5];
}

/// One rendered condition row.
class ConditionRow {
  const ConditionRow({required this.key, required this.label, required this.on, required this.placed});
  final String key;
  final String label;
  final bool on;
  final bool placed;
}

/// Merges the bet's row descriptors with live states and applies the event
/// latch. Rows come from `BetView.conditions` (order kept); live-only rows
/// (no descriptor yet) are appended.
class ConditionBoard {
  ConditionBoard({int Function()? nowMs}) : _now = nowMs ?? (() => DateTime.now().millisecondsSinceEpoch);

  final int Function() _now;
  final Map<String, ConditionState> _live = {};
  final Map<String, int> _lastPulse = {};

  /// Applies a WS `scene` / detect update.
  void update(List<ConditionState> states) {
    final now = _now();
    for (final s in states) {
      _live[s.key] = s;
      if (s.state) _lastPulse[s.key] = now;
    }
  }

  void clear() {
    _live.clear();
    _lastPulse.clear();
  }

  /// [unplaced]: region entities not yet placed on this phone; rows that
  /// use one show a grey dot even before the server reports `placed`.
  List<ConditionRow> rows(Program? program, List<ConditionRef> refs, {Set<String> unplaced = const {}}) {
    final now = _now();
    final out = <ConditionRow>[];
    final seen = <String>{};

    ConditionRow make(String key, int leg, String field, String path, String label) {
      final s = _live[key];
      var on = s?.state ?? false;
      if (!on && program != null && isEventRow(program, leg, field, path)) {
        final at = _lastPulse[key];
        on = at != null && now - at < kLatchMs;
      }
      var placed = s?.placed ?? true;
      if (placed && unplaced.isNotEmpty && program != null) {
        final node = exprAt(program, leg, field, path);
        if (node != null && exprEntities(node).any(unplaced.contains)) placed = false;
      }
      return ConditionRow(key: key, label: label, on: on && placed, placed: placed);
    }

    for (final r in refs) {
      if (!seen.add(r.key)) continue;
      out.add(make(r.key, r.leg, r.field, r.path, r.label));
    }
    for (final s in _live.values) {
      if (!seen.add(s.key)) continue;
      out.add(make(s.key, s.leg, s.field, s.path, s.label));
    }
    return out;
  }
}

/// Rows of a practice result: fired = dot on.
List<ConditionRow> practiceRows(List<PracticeCondition> result) => [
      for (final c in result)
        ConditionRow(key: '${c.leg}/${c.field}/${c.path}', label: c.label, on: c.fired, placed: true),
    ];
