import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/models/world.dart';
import 'package:verdict/screens/world/world_picks.dart';

const _c1 = WorldContract(id: 'c1', label: 'Cut', probBps: 7000);
const _c2 = WorldContract(id: 'c2', label: 'Hold', probBps: 3000);

void main() {
  test('§11.2 single-leg split: 70/30 market gives a 70/30 split', () {
    final s = previewSplit([const Pick(eventId: 'e1', contract: _c1, side: 'yes')], 10000000);
    expect(s.pBps, 7000);
    expect(s.proposer, 7000000);
    expect(s.counterparty, 3000000);
    final no = previewSplit([const Pick(eventId: 'e1', contract: _c1, side: 'no')], 10000000);
    expect(no.pBps, 3000);
    expect(no.proposer, 3000000);
  });

  test('§11.2 floors the proposer stake to whole cents and clamps p', () {
    final s = previewSplit([const Pick(eventId: 'e1', contract: _c1, side: 'yes')], 333333);
    // 333333·7000/10000 = 233333.1 → /10000 = 23 → 230000
    expect(s.proposer, 230000);
    expect(s.counterparty, 103333);
    const sure = WorldContract(id: 'x', label: 'X', probBps: 9990);
    expect(previewSplit([const Pick(eventId: 'e', contract: sure, side: 'yes')], 10000000).pBps, 9900);
    expect(previewSplit([const Pick(eventId: 'e', contract: sure, side: 'no')], 10000000).pBps, 100);
  });

  test('§11.3 parlay multiplies (floored) and clamps once', () {
    final s = previewSplit([
      const Pick(eventId: 'e1', contract: _c1, side: 'yes'),
      const Pick(eventId: 'e2', contract: _c2, side: 'yes'),
    ], 10000000);
    expect(s.pBps, 2100);
    expect(s.proposer, 2100000);
  });

  test('picks: toggle, switch side, leg cap, live price', () {
    final p = Picks();
    expect(p.toggle('e1', _c1, 'yes'), isTrue);
    expect(p.sideOf('e1', 'c1'), 'yes');
    p.toggle('e1', _c1, 'no');
    expect(p.sideOf('e1', 'c1'), 'no');
    expect(p.items.length, 1);
    p.toggle('e1', _c1, 'no');
    expect(p.isEmpty, isTrue);
    for (var i = 0; i < 4; i++) {
      expect(p.toggle('e$i', _c1, 'yes'), isTrue);
    }
    expect(p.toggle('e9', _c1, 'yes'), isFalse, reason: 'MAX_PARLAY_LEGS');
    expect(p.parlay, isTrue);
    p.price('e0', 'c1', 6500);
    expect(p.items.first.contract.probBps, 6500);
    expect(p.items.first.leg.toJson(), {'event_id': 'e0', 'contract_id': 'c1', 'side': 'yes'});
  });
}
