import 'package:flutter/material.dart';

import '../../api/models/draft.dart';
import '../../api/models/huddle.dart';
import '../../contracts/constants.dart';
import '../../contracts/error_codes.dart';
import '../../core/format.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/sheet.dart';
import '../../ui/widgets/text.dart';

/// Stake presets (USDC units).
const List<int> kStakePresets = [1000000, 5000000, 10000000, 20000000];

/// Time-limit presets (seconds).
const List<int> kLimitPresets = [30, 60, 120, 300, 600];

/// Stake each: preset chips or a typed amount. Pops with units.
class StakeSheet extends StatefulWidget {
  const StakeSheet({super.key, this.current});
  final int? current;

  @override
  State<StakeSheet> createState() => _StakeSheetState();
}

class _StakeSheetState extends State<StakeSheet> {
  final _amount = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  void _submitTyped() {
    final units = parseUsd(_amount.text);
    if (units == null || units < MIN_STAKE_UNITS || units > MAX_STAKE_UNITS) {
      setState(() => _error = errorMessage('BAD_STAKE'));
      return;
    }
    Navigator.of(context).pop(units);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(spacing: Space.x1, runSpacing: Space.x1, children: [
          for (final u in kStakePresets)
            AppChip(
              label: formatUsd(u),
              isData: true,
              selected: u == widget.current,
              onTap: () => Navigator.of(context).pop(u),
            ),
        ]),
        const SizedBox(height: Space.x2),
        TextField(
          key: const ValueKey('stake-amount'),
          controller: _amount,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          style: Typo.label,
          decoration: const InputDecoration(hintText: 'Amount', prefixText: r'$'),
          onSubmitted: (_) => _submitTyped(),
        ),
        ErrorLine(_error),
        PrimaryButton(label: 'Set', onPressed: _submitTyped),
      ],
    );
  }
}

/// Time limit presets. Pops with seconds.
class LimitSheet extends StatelessWidget {
  const LimitSheet({super.key, this.current});
  final int? current;

  @override
  Widget build(BuildContext context) {
    final options = {...kLimitPresets, if (current != null) current!}.toList()..sort();
    return Wrap(spacing: Space.x1, runSpacing: Space.x1, children: [
      for (final s in options)
        AppChip(
          label: formatSeconds(s),
          isData: true,
          selected: s == current,
          onTap: () => Navigator.of(context).pop(s),
        ),
    ]);
  }
}

/// Result of the Who sheet: participants in order (creator first) and
/// their sides.
class WhoResult {
  const WhoResult(this.participants, this.sides);
  final List<String> participants;
  final Map<String, int> sides;
}

/// Who's in and on which side (`PATCH /drafts/:id {participants, sides}`).
/// The creator is always in, on side A (§2.4).
class WhoSheet extends StatefulWidget {
  const WhoSheet({super.key, required this.huddle, required this.draft, required this.creatorId});
  final HuddleView huddle;
  final DraftView draft;
  final String creatorId;

  @override
  State<WhoSheet> createState() => _WhoSheetState();
}

class _WhoSheetState extends State<WhoSheet> {
  late final Map<String, int> _sides = {
    for (final p in widget.draft.participants) p.userId: p.side,
  };
  late final Set<String> _in = {for (final p in widget.draft.participants) p.userId, widget.creatorId};

  List<HuddleMember> get _members => widget.huddle.confirmed;

  bool get _valid {
    final ins = _members.where((m) => _in.contains(m.user.id)).toList();
    if (ins.length < MIN_PARTICIPANTS || ins.length > MAX_PARTICIPANTS) return false;
    final sides = ins.map((m) => _sideOf(m.user.id)).toSet();
    return sides.contains(0) && sides.contains(1);
  }

  int _sideOf(String id) => id == widget.creatorId ? 0 : (_sides[id] ?? 1);

  void _done() {
    final order = [
      widget.creatorId,
      for (final m in _members)
        if (m.user.id != widget.creatorId && _in.contains(m.user.id)) m.user.id,
    ];
    Navigator.of(context).pop(WhoResult(order, {for (final id in order) id: _sideOf(id)}));
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Flexible(
          child: SingleChildScrollView(
            child: RowList(children: [
              for (final m in _members)
                ListRow(
                  key: ValueKey('who-${m.user.id}'),
                  label: m.user.displayName,
                  labelIsData: true,
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    for (final side in const [0, 1]) ...[
                      AppChip(
                        label: side == 0 ? 'A' : 'B',
                        selected: _in.contains(m.user.id) && _sideOf(m.user.id) == side,
                        onTap: m.user.id == widget.creatorId
                            ? null
                            : () => setState(() {
                                  _in.add(m.user.id);
                                  _sides[m.user.id] = side;
                                }),
                      ),
                      const SizedBox(width: Space.x1),
                    ],
                    Switch(
                      value: _in.contains(m.user.id),
                      onChanged: m.user.id == widget.creatorId
                          ? null
                          : (v) => setState(() => v ? _in.add(m.user.id) : _in.remove(m.user.id)),
                    ),
                  ]),
                ),
            ]),
          ),
        ),
        const SizedBox(height: Space.x3),
        PrimaryButton(label: 'Done', onPressed: _valid ? _done : null),
      ],
    );
  }
}

/// What: the read-back of the compiled program (data lines) and Play.
class WhatSheet extends StatelessWidget {
  const WhatSheet({super.key, required this.lines, required this.onPlay});
  final List<String> lines;
  final VoidCallback? onPlay;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Flexible(
          child: SingleChildScrollView(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (final l in lines)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: Space.x1),
                  child: DataText(l, maxLines: 4),
                ),
            ]),
          ),
        ),
        const SizedBox(height: Space.x3),
        QuietButton(label: 'Play', onPressed: onPlay),
      ],
    );
  }
}
