import 'package:flutter/material.dart';

import '../../api/api_error.dart';
import '../../api/models/draft.dart';
import '../../capture/voice_capture.dart';
import '../../state/app_controller.dart';
import '../../state/guarded.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/text.dart';

/// "I accept" (spec §3.3 step 5, CONTRACTS.md §12.3/§4.2): say the
/// challenge phrase, then the passkey prompt signs `accept_sig` over
/// `program_hash ‖ sha256(wav)`. Voice is the ritual; the device signature
/// is the security. Pops with true once accepted.
class AcceptSheet extends StatefulWidget {
  const AcceptSheet({super.key, required this.app, required this.draft});
  final AppController app;
  final DraftView draft;

  @override
  State<AcceptSheet> createState() => _AcceptSheetState();
}

class _AcceptSheetState extends State<AcceptSheet> with Guarded {
  AcceptChallenge? _challenge;
  VoiceCapture? _mic;
  bool _recording = false;

  AppController get _app => widget.app;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _mic?.dispose();
    super.dispose();
  }

  Future<void> _load() => guard('challenge', () async {
        final c = await _app.api.acceptChallenge(widget.draft.draftId);
        if (mounted) setState(() => _challenge = c);
      });

  Future<void> _toggle() async {
    final c = _challenge;
    if (c == null) return;
    if (!_recording) {
      await guard('record', () async {
        final mic = _mic ??= _app.newVoiceCapture();
        if (!await mic.hasPermission()) throw ApiException('PHRASE_NOT_HEARD');
        await mic.start();
        if (mounted) setState(() => _recording = true);
      });
      return;
    }
    await guard('accept', () async {
      final wav = await _mic!.stop();
      if (mounted) setState(() => _recording = false);
      final hash = widget.draft.programHash;
      if (hash == null) throw ApiException('WRONG_STATE');
      final sig = await _app.wallet.signAcceptance(programHashHex: hash, wav: wav);
      final r = await _app.api.accept(
        widget.draft.draftId,
        challengeId: c.challengeId,
        audioWav: wav,
        acceptSig: sig,
      );
      if (!r.accepted) throw ApiException('VOICE_NOT_MATCHED');
      if (mounted) Navigator.of(context).pop(true);
    });
    // A failed attempt needs a fresh challenge (two new words).
    if (mounted && error != null) {
      final failed = error;
      await _load();
      if (mounted) setState(() => error = failed);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = _challenge;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: Space.x2),
        SizedBox(
          height: Space.x8 + Space.x2,
          child: Center(
            child: c == null
                ? const SizedBox.shrink()
                : DataText(c.phrase, key: const ValueKey('accept-phrase'), style: Typo.title, maxLines: 2, textAlign: TextAlign.center),
          ),
        ),
        const SizedBox(height: Space.x2),
        Center(
          child: ShutterButton(
            semanticLabel: 'Record',
            active: _recording,
            onPressed: c == null || busyWith('accept') || busyWith('challenge') ? null : _toggle,
          ),
        ),
        const SizedBox(height: Space.x2),
        ErrorLine(error),
      ],
    );
  }
}
