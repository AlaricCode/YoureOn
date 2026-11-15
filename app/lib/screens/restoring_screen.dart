import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../state/app_scope.dart';
import '../ui/tokens.dart';
import '../ui/widgets/controls.dart';
import '../ui/widgets/page.dart';

/// Shown while a stored session could not be checked (offline at launch).
/// The controller keeps retrying with backoff; Retry tries now, and
/// "Sign in instead" drops the stored token.
class RestoringScreen extends StatefulWidget {
  const RestoringScreen({super.key});

  @override
  State<RestoringScreen> createState() => _RestoringScreenState();
}

class _RestoringScreenState extends State<RestoringScreen> {
  bool _busy = false;

  Future<void> _retry() async {
    setState(() => _busy = true);
    try {
      await AppScope.read(context).retryRestore();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: 'Offline',
      back: false,
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          PrimaryButton(label: 'Retry', busy: _busy, onPressed: _busy ? null : _retry),
          const SizedBox(height: Space.x2),
          QuietButton(
            label: 'Sign in instead',
            onPressed: _busy ? null : () => AppScope.read(context).signOut(),
          ),
        ],
      ),
      child: const Center(child: Icon(LucideIcons.wifiOff, size: 32, color: Palette.secondary)),
    );
  }
}
