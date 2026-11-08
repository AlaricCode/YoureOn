import 'package:flutter/material.dart';

import '../../api/models/ruling.dart';
import '../../core/format.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/sheet.dart';

/// Dispute (CONTRACTS.md §12.10): reason chips "Wrong outcome" / "Wrong
/// person" / "Bad tracking" / "Other" (reasons 1–4) plus the bond. Pops
/// with the reason.
class DisputeSheet extends StatefulWidget {
  const DisputeSheet({super.key, required this.bondUnits});
  final int bondUnits;

  @override
  State<DisputeSheet> createState() => _DisputeSheetState();
}

class _DisputeSheetState extends State<DisputeSheet> {
  int? _reason;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(spacing: Space.x1, runSpacing: Space.x1, children: [
          for (final e in kDisputeReasons.entries)
            AppChip(
              key: ValueKey('reason-${e.key}'),
              label: e.value,
              selected: _reason == e.key,
              onTap: () => setState(() => _reason = e.key),
            ),
        ]),
        const SizedBox(height: Space.x2),
        const Hairline(),
        KeyValueRow(label: 'Bond', value: formatUsd(widget.bondUnits)),
        const Hairline(),
        const SizedBox(height: Space.x3),
        PrimaryButton(
          label: 'Dispute',
          onPressed: _reason == null ? null : () => Navigator.of(context).pop(_reason),
        ),
      ],
    );
  }
}
