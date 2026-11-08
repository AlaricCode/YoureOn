import 'package:flutter/material.dart';

import '../../scene/conditions.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/sheet.dart';

/// Practice result: one row per condition, dot on = fired.
class PracticeSheet extends StatelessWidget {
  const PracticeSheet({super.key, required this.rows});
  final List<ConditionRow> rows;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: RowList(children: [
        for (final r in rows)
          ListRow(
            key: ValueKey('practice-${r.key}'),
            label: r.label,
            labelIsData: true,
            trailing: StatusDot(on: r.on),
          ),
      ]),
    );
  }
}
