import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/models/bet.dart';
import 'package:verdict/api/models/scene.dart';
import 'package:verdict/nav/routes.dart';
import 'package:verdict/screens/record/record_screen.dart';
import 'package:verdict/screens/scene/scene_check_screen.dart';
import 'package:verdict/ui/widgets/controls.dart';
import 'package:verdict/ws/ws_messages.dart';

import '../support/copy_rule.dart';
import '../support/fake_server.dart';
import '../support/fixtures.dart';
import '../support/screen_harness.dart';
import '../support/test_app.dart';

Future<StatusDot> _dot(WidgetTester t, String key) async {
  final row = find.byKey(ValueKey('condition-$key'));
  await t.scrollUntilVisible(row, 200, scrollable: find.byType(Scrollable).first);
  return t.widget<StatusDot>(find.descendant(of: row, matching: find.byType(StatusDot)));
}

Future<void> _top(WidgetTester t) async {
  await t.drag(find.byType(Scrollable).first, const Offset(0, 2000));
  await t.pump();
}

void main() {
  testWidgets('creator places the line, sees live rows and stakes', (tester) async {
    final devices = Devices();
    var state = 'proposed';
    var funded = false;
    final s = baseServer()
      ..on('GET /bets/b1', (_) => creatorBetJson(state: state, funded: funded))
      ..on('POST /bets/b1/scene/detect', (_) => {
            'entities': [
              {'entity': 'bin', 'label': 'Trash Can', 'bbox': [6000, 5000, 8000, 9000], 'conf': 87},
            ],
            'conditions': [
              {'leg': 1, 'field': 'success', 'path': '', 'label': 'Into Can', 'state': false, 'placed': false},
            ],
          })
      ..on('PUT /bets/b1/calibration', (req) => {'calibration': jsonDecode(req.body), 'calibration_hash': 'cd' * 32})
      ..on('POST /bets/b1/fund', (_) => {'sign': signJson('tx-fund')})
      ..on('POST /tx/tx-fund/submit', (_) {
        funded = true;
        state = 'funded';
        return confirmedJson();
      });
    final c = await openScreen(tester, s, Routes.scene, const BetArgs('b1'), devices: devices);
    expect(find.byType(SceneCheckScreen), findsOneWidget);
    expect(devices.scene.isOpen, isTrue);

    // Socket down: the single-frame fallback labels the scene.
    devices.scene.emit(0);
    await settle(tester);
    expect(s.called('POST /bets/b1/scene/detect'), hasLength(1));
    expect(find.text('87%'), findsWidgets);
    expect(find.text('Trash Can'), findsWidgets);
    expect((await _dot(tester, '1/success/')).placed, isFalse);
    expectCopyRule(tester, screen: 'Scene check');
    await _top(tester);

    // Stake before the line is placed: refused locally.
    await tester.tap(find.text('Stake'));
    await settle(tester);
    expect(find.text('Place regions'), findsOneWidget);
    expect(s.called('POST /bets/b1/fund'), isEmpty);

    // Place the line: start, end, then the side the shooter stands on.
    await tester.tap(find.byKey(const ValueKey('region-line')));
    await settle(tester);
    expect(find.text('Line start'), findsOneWidget);
    final vf = tester.getTopLeft(find.byKey(const ValueKey('viewfinder')));
    await tester.tapAt(vf + const Offset(171, 100));
    await settle(tester);
    expect(find.text('Line end'), findsOneWidget);
    await tester.tapAt(vf + const Offset(171, 300));
    await settle(tester);
    expect(find.text('Standing side'), findsOneWidget);
    await tester.tapAt(vf + const Offset(60, 200));
    await settle(tester);

    final put = FakeServer.body(s.called('PUT /bets/b1/calibration').single);
    final region = (put['regions'] as List).single as Map;
    expect(region['entity'], 'line');
    expect(region['shape'], 'line');
    expect(region['behind_sign'], 1);
    final pts = (region['points'] as List).cast<List>();
    expect(pts[0][0], 5000);
    expect(pts[1][0], 5000);
    expect(pts[0][1], lessThan(pts[1][1] as int));
    final scene = put['scene'] as Map;
    expect(scene['camera'], containsPair('orientation', 'portrait'));
    expect((scene['camera'] as Map)['width_px'], 720);
    expect((scene['camera'] as Map)['ref_frame_sha256'], hasLength(64));
    expect((scene['entity_refs'] as List).single, containsPair('entity', 'bin'));
    expect(find.text('Placed'), findsOneWidget);

    // Live rows: a pulse lights the row, then the latch lets it go.
    c.injectWs(WsScene(
      'b1',
      SceneUpdate.fromJson({
        'entities': [],
        'conditions': [
          {'leg': 1, 'field': 'success', 'path': '', 'label': 'Into Can', 'state': true, 'placed': true},
        ],
      }),
    ));
    await tester.pump();
    expect((await _dot(tester, '1/success/')).on, isTrue);
    c.injectWs(WsScene(
      'b1',
      SceneUpdate.fromJson({
        'entities': [],
        'conditions': [
          {'leg': 1, 'field': 'success', 'path': '', 'label': 'Into Can', 'state': false, 'placed': true},
        ],
      }),
    ));
    await tester.pump();
    expect((await _dot(tester, '1/success/')).on, isTrue, reason: 'event rows latch');

    // Stake: fund with the saved calibration, then all funded → Record.
    await tapAsync(tester, find.text('Stake'), waitMs: 1200);
    expect(s.called('POST /bets/b1/fund'), hasLength(1));
    expect(s.called('POST /tx/tx-fund/submit'), hasLength(1));
    await settle(tester);
    expect(find.byType(RecordScreen), findsOneWidget);
    expect(devices.runners['b1']!.registered, [true], reason: 'camera + audio witnesses');
    c.dispose();
  });

  testWidgets('other phones: read-only rows and Stake', (tester) async {
    final s = baseServer(asBen: true)
      ..on('GET /bets/b1', (_) => {...betJson(id: 'b1', state: 'proposed'), 'preruling': null, 'calibration': null});
    final devices = Devices();
    final c = await openScreen(tester, s, Routes.scene, const BetArgs('b1'), devices: devices);
    expect(devices.scene.isOpen, isFalse);
    expect(find.byKey(const ValueKey('viewfinder')), findsNothing);
    expect(find.text('Waiting'), findsOneWidget, reason: 'region not placed yet');
    expect(find.text('Practice'), findsNothing);
    expect(find.text('Staked'), findsOneWidget, reason: 'Ben funded in the fixture');
    expectCopyRule(tester, screen: 'Scene check (read-only)');
    // Funded snapshot from the socket moves everyone to Record.
    c.injectWs(WsBet(BetView.fromJson({...betJson(id: 'b1', state: 'funded', updatedAt: 1700000000500), 'preruling': null})));
    await settle(tester);
    expect(find.byType(RecordScreen), findsOneWidget);
    c.dispose();
  });
}
