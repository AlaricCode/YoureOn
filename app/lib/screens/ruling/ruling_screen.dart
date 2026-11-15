import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_error.dart';
import '../../api/models/bet.dart';
import '../../api/models/ruling.dart';
import '../../core/format.dart';
import '../../core/state_labels.dart';
import '../../nav/routes.dart';
import '../../state/guarded.dart';
import '../../state/ws_watch.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/page.dart';
import '../../ui/widgets/sheet.dart';
import '../../ui/widgets/text.dart';
import '../../ws/ws_messages.dart';
import 'dispute_sheet.dart';

/// Booth status → label.
const Map<String, String> kBoothStatus = {
  'collecting': 'Collecting',
  'judging': 'Judging',
  'ruled': 'Ruled',
  'submitted': 'Submitted',
};

/// Ruling (spec §6.5, CONTRACTS.md §12.10): Outcome · Amount · Agree ·
/// Dispute; the replay booth while disputed; Stake for a market bet's
/// counterparty (funding = acceptance, [D-32]).
class RulingScreen extends StatefulWidget {
  const RulingScreen({super.key, required this.args});
  final BetArgs args;

  @override
  State<RulingScreen> createState() => _RulingScreenState();
}

class _RulingScreenState extends State<RulingScreen> with Guarded, WsWatch {
  BetView? _bet;
  RulingView? _ruling;
  final Set<BetState> _announced = {};

  String get _betId => widget.args.betId;

  static const Set<BetState> _ruled = {BetState.preruled, BetState.disputed, BetState.settled, BetState.refunded};

  @override
  void initState() {
    super.initState();
    _bet = widget.args.bet;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      watchWs([Topics.bet(_betId)], _onWs);
      _load();
    });
  }

  Future<void> _load() => guard('load', () async {
        final bet = await app.api.bet(_betId);
        _setBet(bet, announce: false);
        await _loadRuling();
      });

  Future<void> _loadRuling() async {
    final bet = _bet;
    if (bet == null || !_ruled.contains(bet.state)) return;
    try {
      final r = await app.api.ruling(_betId);
      if (mounted) setState(() => _ruling = r);
    } on ApiException catch (e) {
      if (e.code != 'WRONG_STATE') rethrow;
    }
  }

  void _setBet(BetView bet, {bool announce = true}) {
    if (!mounted) return;
    final prev = _bet;
    if (prev != null && prev.updatedAtMs > bet.updatedAtMs) return;
    setState(() => _bet = bet);
    app.upsertBet(bet);
    if (prev?.state != bet.state) {
      unawaited(guard('ruling', _loadRuling, exclusive: false));
      if (announce) _announce(bet);
    }
  }

  void _onWs(WsMessage m) {
    switch (m) {
      case WsBet(:final bet) when bet.id == _betId:
        _setBet(bet);
      case WsChain(:final betId, :final name) when betId == _betId:
        if (name == 'PreRuled' || name == 'Settled' || name == 'Refunded' || name == 'Disputed') {
          unawaited(guard('refresh', () async => _setBet(await app.api.bet(_betId)), exclusive: false));
        }
      case WsBooth(:final betId) when betId == _betId:
        setState(() {});
      default:
        break;
    }
  }

  /// Only the camera phone auto-plays `announce.mp3`, on PreRuled and
  /// Settled (§12.10).
  void _announce(BetView bet) {
    if (bet.state != BetState.preruled && bet.state != BetState.settled) return;
    final me = app.userId;
    final cameraPhone = bet.witnesses.any((w) => w.kind == 'camera' && w.userId == me);
    if (!cameraPhone || !_announced.add(bet.state)) return;
    unawaited(app.audio.play('/bets/${Uri.encodeComponent(bet.id)}/announce.mp3').catchError((Object _) {}));
  }

  Future<void> _agree() => guard('agree', () async {
        await app.tx.run(() => app.api.consent(_betId));
        _setBet(await app.api.bet(_betId));
        await _loadRuling();
      });

  Future<void> _dispute() async {
    final bond = _ruling?.bondUnits ?? _bet?.dispute?.bondUnits ?? 0;
    final reason = await showAppSheet<int>(context, (_) => DisputeSheet(bondUnits: bond));
    if (reason == null || !mounted) return;
    await guard('dispute', () async {
      final first = await app.api.dispute(_betId, reason);
      await app.tx.run(() async => (await app.api.dispute(_betId, reason)).sign, first: first.sign, fresh: true);
      _setBet(await app.api.bet(_betId));
    });
  }

  Future<void> _stake() => guard('stake', () async {
        await app.tx.run(() => app.api.fund(_betId), fresh: true);
        _setBet(await app.api.bet(_betId));
      });

  @override
  Widget build(BuildContext context) {
    final bet = _bet;
    final r = _ruling;
    return AppPage(
      title: 'Ruling',
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [ErrorLine(error), ..._actions(bet, r)],
      ),
      child: ListView(
        children: [
          const SizedBox(height: Space.x2),
          if (bet != null) DataText(bet.title, style: Typo.heading),
          const SizedBox(height: Space.x3),
          ..._outcome(bet, r),
        ],
      ),
    );
  }

  List<Widget> _outcome(BetView? bet, RulingView? r) {
    if (bet == null) return const [];
    if (bet.state == BetState.disputed) {
      return [
        Row(children: [
          const Expanded(child: Label('Replay booth', style: Typo.display)),
          const Tag('Trusted'),
        ]),
        const SizedBox(height: Space.x2),
        const Hairline(),
        KeyValueRow(label: 'Booth', value: kBoothStatus[bet.boothStatus] ?? '—'),
        const Hairline(),
      ];
    }
    if (r == null || !_ruled.contains(bet.state)) {
      return [Label(betStateLabel(bet), key: const ValueKey('ruling-state'), style: Typo.display)];
    }
    return [
      DataText(r.outcomeText, key: const ValueKey('outcome'), style: Typo.display),
      if (r.amountUnits != null) ...[
        const SizedBox(height: Space.x1),
        DataText(formatSignedUsd(r.amountUnits!), key: const ValueKey('amount'), style: Typo.title),
      ],
      if (bet.state != BetState.preruled) ...[
        const SizedBox(height: Space.x2),
        Label(betStateLabel(bet), style: Typo.value),
      ],
    ];
  }

  List<Widget> _actions(BetView? bet, RulingView? r) {
    if (bet == null) return const [];
    final me = bet.me;
    final out = <Widget>[];
    if (bet.state == BetState.proposed && me != null && !me.funded) {
      out.add(PrimaryButton(label: 'Stake', busy: busyWith('stake'), onPressed: busy ? null : _stake));
    } else if (bet.state == BetState.preruled && (r?.canRespond ?? false)) {
      out.add(Row(children: [
        Expanded(child: QuietButton(label: 'Dispute', onPressed: busy ? null : _dispute)),
        const SizedBox(width: Space.x2),
        Expanded(child: PrimaryButton(label: 'Agree', busy: busyWith('agree'), onPressed: busy ? null : _agree)),
      ]));
    }
    if (_ruled.contains(bet.state)) {
      if (out.isNotEmpty) out.add(const SizedBox(height: Space.x2));
      out.add(QuietButton(
        label: 'Receipt',
        onPressed: () => Navigator.of(context).pushNamed(Routes.receipt, arguments: BetArgs(bet.id, bet: bet)),
      ));
    }
    return out;
  }
}
