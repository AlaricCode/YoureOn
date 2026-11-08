import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_error.dart';
import '../../api/models/world.dart';
import '../../core/format.dart';
import '../../nav/routes.dart';
import '../../state/guarded.dart';
import '../../state/ws_watch.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/page.dart';
import '../../ui/widgets/sheet.dart';
import '../../ui/widgets/text.dart';
import '../../ws/ws_messages.dart';
import 'world_picks.dart';

/// A counterparty candidate (confirmed recent huddle member).
class Counterparty {
  const Counterparty(this.userId, this.name);
  final String userId;
  final String name;
}

/// World (spec §6.5, CONTRACTS.md §11, §12.13): Search · Event · Odds ·
/// Stake split · counterparty chip · Propose.
class WorldScreen extends StatefulWidget {
  const WorldScreen({super.key, this.args = const WorldArgs()});
  final WorldArgs args;

  @override
  State<WorldScreen> createState() => _WorldScreenState();
}

class _WorldScreenState extends State<WorldScreen> with Guarded, WsWatch {
  final _query = TextEditingController();
  final _total = TextEditingController();
  final Picks _picks = Picks();
  List<WorldEvent> _events = const [];
  WorldEvent? _event;
  WorldQuote? _quote;
  List<Counterparty> _people = const [];
  String? _counterparty;
  Timer? _searchDebounce;
  Timer? _quoteDebounce;
  int _quoteSeq = 0;
  final Set<String> _priceTopics = {};

  int? get _totalUnits {
    final u = parseUsd(_total.text);
    return u == null || u < 20000 ? null : u; // both stakes ≥ $0.01 (§11.2)
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _search();
      _loadPeople();
    });
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _quoteDebounce?.cancel();
    _query.dispose();
    _total.dispose();
    super.dispose();
  }

  /// Live prices for every event the user opened (§11.5).
  void _watchPrices(String eventId) {
    if (_priceTopics.add(eventId)) watchWs([Topics.world(eventId)], _onWs);
  }

  void _onWs(WsMessage m) {
    if (m is! WsWorldPrice) return;
    setState(() {
      _picks.price(m.eventId, m.contractId, m.probBps);
      final e = _event;
      if (e != null && e.id == m.eventId) {
        _event = WorldEvent(
          id: e.id,
          title: e.title,
          category: e.category,
          closeTimeMs: e.closeTimeMs,
          status: e.status,
          contracts: [for (final c in e.contracts) c.id == m.contractId ? c.withProb(m.probBps) : c],
          resolution: e.resolution,
        );
      }
    });
  }

  Future<void> _loadPeople() => guard('people', () async {
        final me = app.userId;
        final out = <String, Counterparty>{};
        final h = widget.args.huddleId;
        if (h != null) {
          final huddle = await app.api.huddle(h);
          for (final m in huddle.confirmed) {
            if (m.user.id != me) out[m.user.id] = Counterparty(m.user.id, m.user.displayName);
          }
        } else {
          for (final b in app.bets) {
            for (final p in b.participants) {
              if (p.userId != me) out.putIfAbsent(p.userId, () => Counterparty(p.userId, p.displayName));
            }
          }
        }
        if (mounted) {
          setState(() {
            _people = out.values.toList();
            if (_people.length == 1) _counterparty = _people.first.userId;
          });
        }
      }, exclusive: false);

  void _onQuery(String _) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 300), _search);
  }

  Future<void> _search() => guard('search', () async {
        final events = await app.api.worldEvents(q: _query.text.trim(), limit: 20);
        if (mounted) setState(() => _events = events.where((e) => e.status == 'open').toList());
      }, exclusive: false);

  Future<void> _openEvent(WorldEvent e) => guard('event', () async {
        final full = await app.api.worldEvent(e.id);
        if (mounted) setState(() => _event = full);
        _watchPrices(e.id);
      }, exclusive: false);

  void _pick(WorldContract c, String side) {
    final e = _event;
    if (e == null) return;
    setState(() {
      if (!_picks.toggle(e.id, c, side)) error = null;
      _quote = null;
    });
    _requote();
  }

  void _requote() {
    _quoteDebounce?.cancel();
    final total = _totalUnits;
    if (_picks.isEmpty || total == null) {
      setState(() => _quote = null);
      return;
    }
    _quoteDebounce = Timer(const Duration(milliseconds: 300), () {
      final seq = ++_quoteSeq;
      guard('quote', () async {
        final q = await app.api.worldQuote([for (final p in _picks.items) p.leg], total);
        if (mounted && seq == _quoteSeq) setState(() => _quote = q);
      }, exclusive: false);
    });
  }

  Future<void> _propose() => guard('propose', () async {
        final q = _quote!;
        try {
          final first = await app.api.worldBet(quoteId: q.quoteId, counterpartyUserId: _counterparty!);
          await app.tx.run(
            () async => (await app.api.worldBet(quoteId: q.quoteId, counterpartyUserId: _counterparty!)).sign,
            first: first.sign,
          );
          app.upsertBet(first.bet);
          if (mounted) {
            Navigator.of(context).pushReplacementNamed(Routes.ruling, arguments: BetArgs(first.bet.id, bet: first.bet));
          }
        } on ApiException catch (e) {
          if (e.code == 'QUOTE_EXPIRED') _requote();
          rethrow;
        }
      });

  @override
  Widget build(BuildContext context) {
    final e = _event;
    return AppPage(
      title: 'World',
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ErrorLine(error),
          PrimaryButton(
            label: 'Propose',
            busy: busyWith('propose'),
            onPressed: _quote != null && _counterparty != null && !busyWith('propose') ? _propose : null,
          ),
        ],
      ),
      child: ListView(children: [
        const SizedBox(height: Space.x1),
        TextField(
          key: const ValueKey('world-search'),
          controller: _query,
          style: Typo.label,
          textInputAction: TextInputAction.search,
          decoration: const InputDecoration(hintText: 'Search'),
          onChanged: _onQuery,
          onSubmitted: (_) => _search(),
          onTap: () => setState(() => _event = null),
        ),
        const SizedBox(height: Space.x2),
        if (e == null) ..._eventList() else ..._eventDetail(e),
        if (!_picks.isEmpty) ..._stake(),
        const SizedBox(height: Space.x2),
      ]),
    );
  }

  List<Widget> _eventList() => [
        RowList(children: [
          for (final ev in _events)
            ListRow(
              key: ValueKey('event-${ev.id}'),
              label: ev.title,
              labelIsData: true,
              chevron: true,
              onTap: () => _openEvent(ev),
            ),
        ]),
      ];

  List<Widget> _eventDetail(WorldEvent e) => [
        Row(children: [
          Expanded(child: DataText(e.title, style: Typo.heading, maxLines: 2)),
          AppChip(label: 'Events', onTap: () => setState(() => _event = null)),
        ]),
        const SizedBox(height: Space.x2),
        RowList(children: [
          for (final c in e.contracts)
            ListRow(
              key: ValueKey('contract-${c.id}'),
              label: c.label,
              labelIsData: true,
              value: '${c.probBps ~/ 100}%',
              trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                for (final side in const ['yes', 'no']) ...[
                  const SizedBox(width: Space.x1),
                  AppChip(
                    key: ValueKey('pick-${c.id}-$side'),
                    label: side == 'yes' ? 'Yes' : 'No',
                    selected: _picks.sideOf(e.id, c.id) == side,
                    onTap: () => _pick(c, side),
                  ),
                ],
              ]),
            ),
        ]),
      ];

  List<Widget> _stake() {
    final q = _quote;
    final total = _totalUnits;
    // Until the server quote arrives, show the local §11.2 preview.
    final preview = q == null && total != null ? previewSplit(_picks.items, total) : null;
    final odds = q?.pBps ?? preview?.pBps;
    final split = q != null
        ? '${formatUsd(q.proposerUnits)} / ${formatUsd(q.counterpartyUnits)}'
        : preview != null
            ? '${formatUsd(preview.proposer)} / ${formatUsd(preview.counterparty)}'
            : '—';
    return [
      const SizedBox(height: Space.x3),
      if (_picks.parlay) ...[
        const Align(alignment: Alignment.centerLeft, child: Tag('Parlay')),
        const SizedBox(height: Space.x2),
      ],
      TextField(
        key: const ValueKey('world-total'),
        controller: _total,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        style: Typo.label,
        decoration: const InputDecoration(hintText: 'Stake', prefixText: r'$'),
        onChanged: (_) => _requote(),
      ),
      const SizedBox(height: Space.x2),
      const Hairline(),
      KeyValueRow(label: 'Odds', value: odds == null ? '—' : '${odds ~/ 100}%'),
      const Hairline(),
      KeyValueRow(key: const ValueKey('stake-split'), label: 'Stake split', value: split),
      const Hairline(),
      const SizedBox(height: Space.x2),
      Wrap(spacing: Space.x1, runSpacing: Space.x1, children: [
        for (final p in _people)
          AppChip(
            key: ValueKey('counterparty-${p.userId}'),
            label: p.name,
            isData: true,
            selected: _counterparty == p.userId,
            onTap: () => setState(() => _counterparty = p.userId),
          ),
      ]),
    ];
  }
}
