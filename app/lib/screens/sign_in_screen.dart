import 'package:flutter/material.dart';

import '../api/api_error.dart';
import '../state/app_scope.dart';
import '../ui/tokens.dart';
import '../ui/widgets/controls.dart';
import '../ui/widgets/text.dart';
import '../wallet/wallet.dart';

/// Sign in (spec §6.5, CONTRACTS.md §12.12): wordmark, Google, email.
/// The passkey prompt appears only to unlock the wallet for the login
/// signature ([D-41]).
class SignInScreen extends StatelessWidget {
  const SignInScreen({super.key});

  Future<void> _open(BuildContext context, _Provider p) => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (_) => _SignInSheet(provider: p),
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: Space.page),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              const Label('Verdict', style: Typo.display, textAlign: TextAlign.center),
              const Spacer(),
              PrimaryButton(label: 'Continue with Google', onPressed: () => _open(context, _Provider.google)),
              const SizedBox(height: Space.x2),
              QuietButton(label: 'Continue with email', onPressed: () => _open(context, _Provider.email)),
              const SizedBox(height: Space.x4),
            ],
          ),
        ),
      ),
    );
  }
}

enum _Provider { google, email }

class _SignInSheet extends StatefulWidget {
  const _SignInSheet({required this.provider});
  final _Provider provider;

  @override
  State<_SignInSheet> createState() => _SignInSheetState();
}

class _SignInSheetState extends State<_SignInSheet> {
  final _email = TextEditingController();
  final _code = TextEditingController();
  bool _codeSent = false;
  bool _busy = false;
  String? _error;

  static final _emailRe = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

  bool get _emailOk => _emailRe.hasMatch(_email.text.trim());
  bool get _codeOk => RegExp(r'^\d{6}$').hasMatch(_code.text.trim());

  @override
  void dispose() {
    _email.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() f) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await f();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on WalletLockedException {
      // Prompt dismissed: stay on the sheet, no message.
    } catch (_) {
      if (mounted) setState(() => _error = ApiException('INTERNAL').message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _continue() async {
    final app = AppScope.read(context);
    final email = _email.text.trim().toLowerCase();
    if (widget.provider == _Provider.google) {
      // Offline Google provider ([D-10]): credential = "mock:<email>".
      await _run(() async {
        await app.signIn(provider: 'google', credential: 'mock:$email');
        if (mounted) Navigator.of(context).pop();
      });
      return;
    }
    if (!_codeSent) {
      await _run(() async {
        await app.api.emailStart(email);
        if (mounted) setState(() => _codeSent = true);
      });
      return;
    }
    await _run(() async {
      await app.signIn(provider: 'email', credential: email, emailCode: _code.text.trim());
      if (mounted) Navigator.of(context).pop();
    });
  }

  @override
  Widget build(BuildContext context) {
    final inset = MediaQuery.viewInsetsOf(context).bottom;
    final canGo = _codeSent ? _codeOk : _emailOk;
    return Padding(
      padding: EdgeInsets.fromLTRB(Space.page, Space.x3, Space.page, Space.x3 + inset),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            key: const ValueKey('email'),
            controller: _email,
            enabled: !_codeSent && !_busy,
            autofocus: true,
            keyboardType: TextInputType.emailAddress,
            autocorrect: false,
            style: Typo.label,
            decoration: const InputDecoration(hintText: 'Email'),
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) => canGo ? _continue() : null,
          ),
          if (_codeSent) ...[
            const SizedBox(height: Space.x2),
            TextField(
              key: const ValueKey('code'),
              controller: _code,
              enabled: !_busy,
              autofocus: true,
              keyboardType: TextInputType.number,
              maxLength: 6,
              style: Typo.label,
              decoration: const InputDecoration(hintText: 'Code', counterText: ''),
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _codeOk ? _continue() : null,
            ),
          ],
          ErrorLine(_error),
          PrimaryButton(
            label: widget.provider == _Provider.email && !_codeSent ? 'Send code' : 'Continue',
            busy: _busy,
            onPressed: canGo ? _continue : null,
          ),
        ],
      ),
    );
  }
}
