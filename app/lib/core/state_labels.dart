import '../api/models/bet.dart';

/// State labels (CONTRACTS.md §12.9). `settled` depends on the viewer:
/// "Won" / "Lost" for participants, "Settled" for bystanders.
String stateLabel(BetState state, {bool? won}) {
  switch (state) {
    case BetState.proposed:
      return 'Waiting';
    case BetState.funded:
      return 'Ready';
    case BetState.live:
      return 'Live';
    case BetState.perceiving:
      return 'Reviewing';
    case BetState.preruled:
      return 'Ruled';
    case BetState.disputed:
      return 'Replay booth';
    case BetState.settled:
      if (won == null) return 'Settled';
      return won ? 'Won' : 'Lost';
    case BetState.refunded:
      return 'Refunded';
  }
}

/// Label for a bet as seen by the current user.
String betStateLabel(BetView bet) {
  if (bet.state != BetState.settled) return stateLabel(bet.state);
  final i = bet.myIndex;
  final s = bet.settlement;
  if (!bet.isParticipant || i == null || s == null) {
    return bet.isParticipant ? bet.stateLabel : stateLabel(BetState.settled);
  }
  return stateLabel(BetState.settled, won: (s.winnerMask >> i) & 1 == 1);
}
