import '../../api/models/world.dart';
import '../../contracts/constants.dart';

/// One parlay leg picked in World (§11.3: 1..4 distinct contracts).
class Pick {
  const Pick({required this.eventId, required this.contract, required this.side});
  final String eventId;
  final WorldContract contract;
  final String side; // yes | no

  QuoteLeg get leg => QuoteLeg(eventId: eventId, contractId: contract.id, side: side);
  String get key => '$eventId/${contract.id}';
}

/// Picks with the §11.3 rules: one side per contract, at most
/// `MAX_PARLAY_LEGS`; picking the same side again removes the leg.
class Picks {
  final List<Pick> _items = [];

  List<Pick> get items => List.unmodifiable(_items);
  bool get isEmpty => _items.isEmpty;
  bool get parlay => _items.length > 1;

  String? sideOf(String eventId, String contractId) {
    for (final p in _items) {
      if (p.eventId == eventId && p.contract.id == contractId) return p.side;
    }
    return null;
  }

  /// Returns false when the leg limit blocks a new pick.
  bool toggle(String eventId, WorldContract c, String side) {
    final i = _items.indexWhere((p) => p.eventId == eventId && p.contract.id == c.id);
    if (i >= 0) {
      final same = _items[i].side == side;
      _items.removeAt(i);
      if (same) return true;
      _items.insert(i, Pick(eventId: eventId, contract: c, side: side));
      return true;
    }
    if (_items.length >= MAX_PARLAY_LEGS) return false;
    _items.add(Pick(eventId: eventId, contract: c, side: side));
    return true;
  }

  /// Applies a live price (`world.price`).
  void price(String eventId, String contractId, int probBps) {
    for (var i = 0; i < _items.length; i++) {
      final p = _items[i];
      if (p.eventId == eventId && p.contract.id == contractId) {
        _items[i] = Pick(eventId: eventId, contract: p.contract.withProb(probBps), side: p.side);
      }
    }
  }

  void clear() => _items.clear();
}

/// §11.2/§11.3 stake split preview (the server quote is authoritative):
/// `p` = product of the proposer-side probabilities (floored per step),
/// clamped; proposer stake floored to whole cents.
({int pBps, int proposer, int counterparty}) previewSplit(List<Pick> picks, int totalUnits) {
  int sideP(Pick p) => p.side == 'yes' ? p.contract.probBps : 10000 - p.contract.probBps;
  var pBig = BigInt.from(sideP(picks.first));
  for (final p in picks.skip(1)) {
    pBig = pBig * BigInt.from(sideP(p)) ~/ BigInt.from(10000);
  }
  var pp = pBig.toInt();
  if (pp < PROB_CLAMP_MIN_BPS) pp = PROB_CLAMP_MIN_BPS;
  if (pp > PROB_CLAMP_MAX_BPS) pp = PROB_CLAMP_MAX_BPS;
  final t = BigInt.from(totalUnits);
  final proposer = (t * BigInt.from(pp) ~/ BigInt.from(10000) ~/ BigInt.from(10000) * BigInt.from(10000)).toInt();
  return (pBps: pp, proposer: proposer, counterparty: totalUnits - proposer);
}
