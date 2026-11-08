import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/models/draft.dart';
import 'package:verdict/nav/routes.dart';
import 'package:verdict/screens/huddle/huddle_screen.dart';
import 'package:verdict/screens/terms/terms_screen.dart';
import 'package:verdict/ui/widgets/controls.dart';
import 'package:verdict/ws/ws_messages.dart';

import '../support/copy_rule.dart';
import '../support/fake_server.dart';
import '../support/fixtures.dart';
import '../support/screen_harness.dart';

void main() {
  testWidgets('creator: create, scan to confirm, continue to Terms', (tester) async {
    var benConfirmed = false;
    final s = baseServer()
      ..on('POST /huddles', (_) => {'huddle_id': 'h1', 'code': '482913'})
      ..on('GET /huddles/h1', (_) => huddleJson(benConfirmed: benConfirmed))
      ..on('POST /huddles/h1/scan', (_) {
        benConfirmed = true;
        return {
          'matches': [
            {
              'bbox': [3000, 2000, 7000, 7000],
              'user': userJson(id: 'u2', name: 'Ben'),
              'cos_bps': 8100,
              'matched': true,
            },
          ],
        };
      });
    final c = await openScreen(tester, s, Routes.huddle, const HuddleArgs());
    expect(find.byType(HuddleScreen), findsOneWidget);
    expect(find.text('482913'), findsOneWidget);
    expect(find.text('Ana'), findsOneWidget);
    expect(find.text('Ben'), findsOneWidget);
    expectCopyRule(tester, screen: 'Huddle');

    // One confirmed member: Continue is disabled.
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.byType(TermsScreen), findsNothing);

    await tester.tap(find.byType(ShutterButton));
    await tester.pumpAndSettle();
    final scan = FakeServer.body(s.called('POST /huddles/h1/scan').single);
    final faces = scan['faces'] as List;
    expect(faces.length, 1);
    expect((faces.single as Map)['bbox'], [3000, 2000, 7000, 7000]);
    expect((faces.single as Map)['crop_b64'], isA<String>());

    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.byType(TermsScreen), findsOneWidget);
    c.dispose();
  });

  testWidgets('scan without a match shows the fixed message', (tester) async {
    final s = baseServer()
      ..on('POST /huddles', (_) => {'huddle_id': 'h1', 'code': '482913'})
      ..on('GET /huddles/h1', (_) => huddleJson(benConfirmed: false))
      ..on('POST /huddles/h1/scan', (_) => {
            'matches': [
              {'bbox': [0, 0, 10, 10], 'user': null, 'cos_bps': 1200, 'matched': false},
            ],
          });
    final c = await openScreen(tester, s, Routes.huddle, const HuddleArgs());
    await tester.tap(find.byType(ShutterButton));
    await tester.pumpAndSettle();
    expect(find.text('Face not matched'), findsOneWidget);
    c.dispose();
  });

  testWidgets('member: joins by code and follows the draft to Terms', (tester) async {
    final s = baseServer(asBen: true)
      ..on('POST /huddles', (_) => {'huddle_id': 'h9', 'code': '000111'})
      ..on('GET /huddles/h9', (_) => huddleJson(id: 'h9', creator: 'u2'))
      ..on('POST /huddles/join', (_) => huddleJson())
      ..on('GET /huddles/h1', (_) => huddleJson())
      ..on('GET /drafts/d1', (_) => readyDraftJson());
    final c = await openScreen(tester, s, Routes.huddle, const HuddleArgs());

    await tester.tap(find.text('Join'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('join-code')), '482913');
    await tester.pump();
    await tester.tap(find.widgetWithText(GestureDetector, 'Join').last);
    await tester.pumpAndSettle();
    expect(FakeServer.body(s.called('POST /huddles/join').single), {'code': '482913'});
    expect(find.text('Waiting'), findsOneWidget, reason: 'members wait for the creator');
    expect(find.byType(ShutterButton), findsNothing);

    c.injectWs(WsDraft('h1', DraftView.fromJson(readyDraftJson())));
    await tester.pumpAndSettle();
    expect(find.byType(TermsScreen), findsOneWidget);
    expect(s.called('GET /drafts/d1'), isNotEmpty);
    c.dispose();
  });
}
