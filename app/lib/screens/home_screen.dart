import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../api/api_error.dart';
import '../api/models/bet.dart';
import '../core/format.dart';
import '../core/state_labels.dart';
import '../nav/routes.dart';
import '../state/app_scope.dart';
import '../ui/tokens.dart';
import '../ui/widgets/controls.dart';
import '../ui/widgets/text.dart';

/// Home (CONTRACTS.md §12.13): Balance · New bet · Bets list (title, stake,
/// state label) · Pay · profile row (→ Enroll).
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  String? _error;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  Future<void> _refresh() async {
    try {
      await AppScope.read(context).refreshHome();
      if (mounted) setState(() => _error = null);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loaded = true);
    }
  }

  Future<void> _faucet() async {
    try {
      await AppScope.read(context).faucet();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  void _open(BetView bet) =>
      Navigator.of(context).pushNamed(routeForBet(bet), arguments: BetArgs(bet.id, bet: bet));

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final user = app.user;
    final balance = app.balanceUnits;
    final bets = app.bets;

    return Scaffold(
      body: SafeArea(
        child: RefreshIndicator(
          color: Palette.text,
          backgroundColor: Palette.surface,
          onRefresh: _refresh,
          child: CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: [
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(Space.page, Space.x5, Space.page, 0),
                sliver: SliverList.list(children: [
                  const Label('Balance', style: Typo.value),
                  const SizedBox(height: Space.x1),
                  // Long-press: demo drip (`POST /faucet`), no visible copy.
                  GestureDetector(
                    onLongPress: _faucet,
                    child: DataText(
                      balance == null ? '—' : formatUsd(balance),
                      key: const ValueKey('balance'),
                      style: Typo.display,
                    ),
                  ),
                  const SizedBox(height: Space.x4),
                  Row(children: [
                    Expanded(
                      child: PrimaryButton(
                        label: 'New bet',
                        onPressed: () => Navigator.of(context).pushNamed(Routes.huddle, arguments: const HuddleArgs()),
                      ),
                    ),
                    const SizedBox(width: Space.x2),
                    Expanded(
                      child: QuietButton(
                        label: 'Pay',
                        onPressed: () => Navigator.of(context).pushNamed(Routes.pay),
                      ),
                    ),
                  ]),
                  ErrorLine(_error),
                  const SizedBox(height: Space.x2),
                  const Label('Bets', style: Typo.heading),
                  const SizedBox(height: Space.x1),
                  const Hairline(),
                ]),
              ),
              if (_loaded && bets.isEmpty)
                const SliverToBoxAdapter(child: SizedBox(height: Space.x8))
              else
                SliverPadding(
                  padding: const EdgeInsets.symmetric(horizontal: Space.page),
                  sliver: SliverList.separated(
                    itemCount: bets.length,
                    separatorBuilder: (_, __) => const Hairline(),
                    itemBuilder: (_, i) => _BetRow(bet: bets[i], onTap: () => _open(bets[i])),
                  ),
                ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(Space.page, Space.x3, Space.page, Space.x4),
                sliver: SliverList.list(children: [
                  const Hairline(),
                  if (user != null)
                    ListRow(
                      key: const ValueKey('profile'),
                      label: user.displayName,
                      labelIsData: true,
                      leading: const Icon(LucideIcons.user, size: 18, color: Palette.secondary),
                      chevron: true,
                      onTap: () => Navigator.of(context).pushNamed(Routes.enroll),
                    ),
                ]),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BetRow extends StatelessWidget {
  const _BetRow({required this.bet, required this.onTap});
  final BetView bet;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final stake = bet.myStakeUnits ?? bet.stakeEachUnits;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: SizedBox(
        height: Space.x8,
        child: Row(children: [
          if (bet.state == BetState.live) ...[
            const StatusDot(on: true, live: true),
            const SizedBox(width: Space.x2),
          ],
          Expanded(child: DataText(bet.title)),
          if (stake != null) ...[
            const SizedBox(width: Space.x2),
            DataText(formatUsd(stake), style: Typo.value),
          ],
          const SizedBox(width: Space.x2),
          SizedBox(
            width: 96,
            child: Label(betStateLabel(bet), style: Typo.value, textAlign: TextAlign.right),
          ),
        ]),
      ),
    );
  }
}
