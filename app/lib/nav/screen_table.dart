import 'package:flutter/widgets.dart';

import '../screens/enroll_screen.dart';
import '../screens/home_screen.dart';
import '../screens/huddle/huddle_screen.dart';
import '../screens/pay/pay_screen.dart';
import '../screens/receipt/receipt_screen.dart';
import '../screens/record/record_screen.dart';
import '../screens/ruling/ruling_screen.dart';
import '../screens/scene/scene_check_screen.dart';
import '../screens/sign_in_screen.dart';
import '../screens/terms/terms_screen.dart';
import '../screens/world/world_screen.dart';
import 'routes.dart';

/// Route name → screen. Screens receive `RouteSettings.arguments` (see the
/// *Args classes in routes.dart).
final Map<String, Widget Function(Object? args)> screenTable = {
  Routes.signIn: (_) => const SignInScreen(),
  Routes.enroll: (_) => const EnrollScreen(),
  Routes.home: (_) => const HomeScreen(),
  Routes.huddle: (a) => HuddleScreen(args: a is HuddleArgs ? a : const HuddleArgs()),
  Routes.terms: (a) => TermsScreen(args: a as TermsArgs),
  Routes.scene: (a) => SceneCheckScreen(args: a as BetArgs),
  Routes.record: (a) => RecordScreen(args: a as BetArgs),
  Routes.ruling: (a) => RulingScreen(args: a as BetArgs),
  Routes.receipt: (a) => ReceiptScreen(args: a as BetArgs),
  Routes.pay: (_) => const PayScreen(),
  Routes.world: (a) => WorldScreen(args: a is WorldArgs ? a : const WorldArgs()),
};

Route<dynamic>? onGenerateRoute(RouteSettings settings) {
  final build = screenTable[settings.name];
  if (build == null) return null;
  return AppRoute<dynamic>(settings: settings, builder: (_) => build(settings.arguments));
}
