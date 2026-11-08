import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../api/models/draft.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';

/// One clarifying question (CONTRACTS.md §12.2/§12.10). The question text is
/// spoken via `audio_url`; the UI shows only its chips (plus a replay
/// control). `choice` answers on tap; `multi` toggles chips then Done;
/// `free` takes typed text.
class QuestionChips extends StatefulWidget {
  const QuestionChips({super.key, required this.question, required this.onAnswer, this.onReplay, this.enabled = true});
  final Question question;
  final ValueChanged<String> onAnswer;
  final VoidCallback? onReplay;
  final bool enabled;

  @override
  State<QuestionChips> createState() => _QuestionChipsState();
}

class _QuestionChipsState extends State<QuestionChips> {
  final Set<String> _picked = {};
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = widget.question;
    final enabled = widget.enabled;
    final replay = widget.onReplay;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Space.x1),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            button: true,
            label: 'Replay',
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: replay,
              child: SizedBox(
                width: Space.x4,
                height: Space.x4 + Space.x1,
                child: Icon(
                  LucideIcons.volume2,
                  size: 18,
                  color: replay == null ? Palette.hairline : Palette.secondary,
                ),
              ),
            ),
          ),
          const SizedBox(width: Space.x1),
          Expanded(child: q.kind == QuestionKind.free ? _free(enabled) : _chips(q, enabled)),
        ],
      ),
    );
  }

  Widget _chips(Question q, bool enabled) {
    final multi = q.kind == QuestionKind.multi;
    return Wrap(spacing: Space.x1, runSpacing: Space.x1, children: [
      for (final c in q.chips)
        AppChip(
          key: ValueKey('q-${q.id}-$c'),
          label: c,
          isData: true,
          selected: _picked.contains(c),
          onTap: !enabled
              ? null
              : () {
                  if (multi) {
                    setState(() => _picked.contains(c) ? _picked.remove(c) : _picked.add(c));
                  } else {
                    widget.onAnswer(c);
                  }
                },
        ),
      if (multi)
        AppChip(
          key: ValueKey('q-${q.id}-done'),
          label: 'Done',
          onTap: enabled && _picked.isNotEmpty
              ? () => widget.onAnswer([for (final c in q.chips) if (_picked.contains(c)) c].join(', '))
              : null,
        ),
    ]);
  }

  Widget _free(bool enabled) {
    return TextField(
      key: ValueKey('q-${widget.question.id}-text'),
      controller: _text,
      enabled: enabled,
      style: Typo.label,
      textInputAction: TextInputAction.send,
      decoration: const InputDecoration(hintText: 'Answer'),
      onSubmitted: (v) {
        if (v.trim().isNotEmpty) widget.onAnswer(v.trim());
      },
    );
  }
}
