import 'package:flutter/material.dart';

import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';

/// Six-digit huddle code entry. Pops with the code.
class JoinSheet extends StatefulWidget {
  const JoinSheet({super.key});

  @override
  State<JoinSheet> createState() => _JoinSheetState();
}

class _JoinSheetState extends State<JoinSheet> {
  final _code = TextEditingController();

  bool get _ok => RegExp(r'^\d{6}$').hasMatch(_code.text.trim());

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  void _submit() {
    if (_ok) Navigator.of(context).pop(_code.text.trim());
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const ValueKey('join-code'),
          controller: _code,
          autofocus: true,
          keyboardType: TextInputType.number,
          maxLength: 6,
          style: Typo.label,
          decoration: const InputDecoration(hintText: 'Code', counterText: ''),
          onChanged: (_) => setState(() {}),
          onSubmitted: (_) => _submit(),
        ),
        const SizedBox(height: Space.x3),
        PrimaryButton(label: 'Join', onPressed: _ok ? _submit : null),
      ],
    );
  }
}
