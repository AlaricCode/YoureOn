import 'json.dart';

class RulingLeg {
  const RulingLeg({required this.id, required this.result, required this.decisiveFrames});
  final int id;
  final int result;
  final List<int> decisiveFrames;

  factory RulingLeg.fromJson(Object? v) {
    final j = asJson(v);
    return RulingLeg(
      id: asInt(j['id']),
      result: asInt(j['result']),
      decisiveFrames: asIntList(j['decisive_frames']),
    );
  }
}

/// `GET /bets/:id/ruling` (CONTRACTS.md §12.3, §12.10).
class RulingView {
  const RulingView({
    required this.outcomeText,
    required this.preruling,
    required this.readback,
    required this.legs,
    required this.amountUnits,
    required this.canRespond,
    required this.bondUnits,
  });

  final String outcomeText; // "You win" / "You lose" / "{Name} wins" / "No contest" / "Replay booth"
  final Object? preruling; // pre-ruling code or object, kept as sent
  final List<String> readback;
  final List<RulingLeg> legs;
  final int? amountUnits; // net, signed; null for NEEDS_PANEL and bystanders
  final bool canRespond;
  final int bondUnits;

  factory RulingView.fromJson(Object? v) {
    final j = asJson(v, 'ruling');
    return RulingView(
      outcomeText: asString(j['outcome_text']),
      preruling: j['preruling'],
      readback: asStringList(j['readback']),
      legs: asList(j['legs'], RulingLeg.fromJson),
      amountUnits: asIntOrNull(j['amount_units']),
      canRespond: asBool(j['can_respond']),
      bondUnits: asInt(j['bond_units']),
    );
  }
}

/// Dispute reasons 1–4 and their chip labels (§12.10).
const Map<int, String> kDisputeReasons = {
  1: 'Wrong outcome',
  2: 'Wrong person',
  3: 'Bad tracking',
  4: 'Other',
};
