import 'package:flutter/widgets.dart';

import '../api/models/bet.dart';
import '../api/models/program.dart';
import '../ui/tokens.dart';

/// Route names (CONTRACTS.md §12.13).
abstract final class Routes {
  static const String signIn = '/sign-in';
  static const String enroll = '/enroll';
  static const String home = '/home';
  static const String huddle = '/huddle';
  static const String terms = '/terms';
  static const String scene = '/scene';
  static const String record = '/record';
  static const String ruling = '/ruling';
  static const String receipt = '/receipt';
  static const String pay = '/pay';
  static const String world = '/world';
}

/// Arguments for bet-scoped screens (Scene check, Record, Ruling, Receipt).
class BetArgs {
  const BetArgs(this.betId, {this.bet});
  final String betId;
  final BetView? bet; // optional snapshot to render immediately
}

/// Arguments for Huddle (null = create a new huddle).
class HuddleArgs {
  const HuddleArgs({this.huddleId, this.joinCode});
  final String? huddleId;
  final String? joinCode;
}

/// Arguments for Terms.
class TermsArgs {
  const TermsArgs({required this.huddleId, this.draftId});
  final String huddleId;
  final String? draftId;
}

/// Arguments for World.
class WorldArgs {
  const WorldArgs({this.huddleId, this.draftId});
  final String? huddleId;
  final String? draftId;
}

/// Page route with the app's only transition: 150 ms fade, easeOut.
class AppRoute<T> extends PageRouteBuilder<T> {
  AppRoute({required WidgetBuilder builder, super.settings})
      : super(
          transitionDuration: Motion.fast,
          reverseTransitionDuration: Motion.fast,
          pageBuilder: (context, _, __) => builder(context),
          transitionsBuilder: (context, animation, _, child) => FadeTransition(
            opacity: CurvedAnimation(parent: animation, curve: Motion.curve),
            child: child,
          ),
        );
}

/// Where tapping a bet in Home leads (§12.13 flow order).
String routeForBet(BetView bet) {
  if (bet.kind == ProgramKind.market) return Routes.ruling;
  switch (bet.state) {
    case BetState.proposed:
    case BetState.funded:
      return Routes.scene;
    case BetState.live:
      return Routes.record;
    case BetState.perceiving:
    case BetState.preruled:
    case BetState.disputed:
    case BetState.settled:
    case BetState.refunded:
      return Routes.ruling;
  }
}
