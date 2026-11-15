import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../api/api_error.dart';
import '../capture/face_capture.dart';
import '../capture/voice_capture.dart';
import '../state/app_controller.dart';
import '../state/app_scope.dart';
import '../ui/tokens.dart';
import '../ui/widgets/controls.dart';
import '../ui/widgets/page.dart';
import '../ui/widgets/text.dart';
import '../wallet/wallet.dart';
import 'enroll/enroll_flow.dart';

enum _Step { idle, face, voice }

/// Enroll (CONTRACTS.md §12.13): Camera · Face · Voice · "I consent" · Done.
/// In enrolled mode: Face/Voice status and "Delete biometrics".
class EnrollScreen extends StatefulWidget {
  const EnrollScreen({super.key});

  @override
  State<EnrollScreen> createState() => _EnrollScreenState();
}

class _EnrollScreenState extends State<EnrollScreen> {
  late final AppController _app = AppScope.read(context);
  late final EnrollFlow _flow = EnrollFlow(_app.api);
  FaceCapture? _camera;
  VoiceCapture? _mic;
  _Step _step = _Step.idle;
  bool _busy = false;
  bool _recording = false;
  String? _error;

  /// "Delete biometrics" needs a second tap within [_armWindow].
  bool _armed = false;
  Timer? _disarm;
  static const Duration _armWindow = Duration(seconds: 3);

  @override
  void dispose() {
    _disarm?.cancel();
    _camera?.close();
    _mic?.dispose();
    super.dispose();
  }

  Future<void> _guard(Future<void> Function() f) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await f();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on WalletLockedException {
      // dismissed
    } catch (_) {
      if (mounted) setState(() => _error = ApiException('INTERNAL').message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ---- face -------------------------------------------------------------

  Future<void> _startFace() => _guard(() async {
        await _stopMic();
        await _flow.ensureChallenge();
        final cam = _camera ??= _app.newFaceCapture();
        try {
          await cam.open(front: true);
        } catch (_) {
          throw ApiException('NO_CAMERA');
        }
        _flow.faceFrames.clear();
        if (mounted) setState(() => _step = _Step.face);
      });

  Future<void> _captureFace() => _guard(() async {
        final cam = _camera;
        if (cam == null) return;
        final frame = await cam.capture();
        final code = _flow.addFaceFrame(frame);
        if (code != null) throw ApiException(code);
        if (_flow.faceReady) {
          await _flow.submitFace();
          await cam.close();
          _camera = null;
          if (mounted) setState(() => _step = _Step.idle);
        } else {
          if (mounted) setState(() {});
        }
      });

  // ---- voice ------------------------------------------------------------

  Future<void> _startVoice() => _guard(() async {
        await _camera?.close();
        _camera = null;
        await _flow.ensureChallenge();
        final mic = _mic ??= _app.newVoiceCapture();
        if (!await mic.hasPermission()) throw ApiException('PHRASE_NOT_HEARD');
        _flow.voiceClips.clear();
        if (mounted) setState(() => _step = _Step.voice);
      });

  Future<void> _toggleRecord() => _guard(() async {
        final mic = _mic;
        if (mic == null) return;
        if (!_recording) {
          await mic.start();
          if (mounted) setState(() => _recording = true);
          return;
        }
        final wav = await mic.stop();
        if (mounted) setState(() => _recording = false);
        _flow.voiceClips.add(wav);
        if (_flow.voiceReady) {
          await _flow.submitVoice();
          if (mounted) setState(() => _step = _Step.idle);
        } else {
          if (mounted) setState(() {});
        }
      });

  Future<void> _stopMic() async {
    if (_recording) {
      await _mic?.stop();
      _recording = false;
    }
  }

  // ---- finish / delete ----------------------------------------------------

  Future<void> _done() => _guard(() async {
        final name = _app.user?.displayName ?? '';
        final first = await _app.api.enrollComplete(displayName: name);
        await _app.tx.run(
          () async => (await _app.api.enrollComplete(displayName: name)).sign,
          first: first.sign,
        );
        await _app.refreshUser();
        if (mounted && Navigator.of(context).canPop()) Navigator.of(context).pop();
      });

  void _onDeleteTap() {
    if (!_armed) {
      setState(() => _armed = true);
      _disarm?.cancel();
      _disarm = Timer(_armWindow, () {
        if (mounted) setState(() => _armed = false);
      });
      return;
    }
    _disarm?.cancel();
    setState(() => _armed = false);
    _delete();
  }

  Future<void> _delete() => _guard(() async {
        final sign = await _app.api.enrollDelete();
        await _app.tx.run(_app.api.enrollDelete, first: sign);
        _flow
          ..resetChallenge()
          ..consent = false;
        await _app.refreshUser();
      });

  // ---- UI -----------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final user = AppScope.of(context).user;
    final enrolled = user?.enrolled ?? false;
    return AppPage(
      title: 'Enroll',
      child: enrolled ? _enrolled() : _enrolling(),
    );
  }

  Widget _enrolled() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: Space.x2),
        const ListRow(label: 'Face', trailing: Icon(LucideIcons.check, size: 18, color: Palette.text)),
        const Hairline(),
        const ListRow(label: 'Voice', trailing: Icon(LucideIcons.check, size: 18, color: Palette.text)),
        const Hairline(),
        const Spacer(),
        ErrorLine(_error),
        QuietButton(
          key: const ValueKey('delete-biometrics'),
          label: _armed ? 'Confirm delete' : 'Delete biometrics',
          busy: _busy,
          onPressed: _busy ? null : _onDeleteTap,
        ),
        const SizedBox(height: Space.x2),
        QuietButton(label: 'Sign out', onPressed: _busy ? null : () => _app.signOut()),
        const SizedBox(height: Space.x2),
      ],
    );
  }

  Widget _enrolling() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: Space.x1),
        AspectRatio(
          aspectRatio: 3 / 4,
          child: ClipRRect(
            borderRadius: const BorderRadius.all(Radius.circular(12)),
            child: ColoredBox(color: Palette.surface, child: _stage()),
          ),
        ),
        const SizedBox(height: Space.x2),
        ListRow(
          label: 'Face',
          trailing: StatusDot(on: _flow.faceDone),
          chevron: !_flow.faceDone,
          onTap: _busy || _flow.faceDone ? null : _startFace,
        ),
        const Hairline(),
        ListRow(
          label: 'Voice',
          trailing: StatusDot(on: _flow.voiceDone),
          chevron: !_flow.voiceDone,
          onTap: _busy || _flow.voiceDone ? null : _startVoice,
        ),
        const Hairline(),
        ListRow(
          label: 'I consent',
          trailing: Switch(
            key: const ValueKey('consent'),
            value: _flow.consent,
            onChanged: _busy ? null : (v) => setState(() => _flow.consent = v),
          ),
        ),
        const Spacer(),
        ErrorLine(_error),
        PrimaryButton(label: 'Done', busy: _busy && _step == _Step.idle, onPressed: _flow.canFinish ? _done : null),
        const SizedBox(height: Space.x2),
      ],
    );
  }

  /// The camera / phrase area at the top of the screen.
  Widget _stage() {
    switch (_step) {
      case _Step.face:
        final cam = _camera;
        final prompt = _flow.nextFacePrompt;
        return Stack(
          fit: StackFit.expand,
          children: [
            if (cam != null && cam.isOpen) cam.preview(),
            Positioned(
              top: Space.x2,
              left: 0,
              right: 0,
              child: Label(prompt?.label ?? 'Look ahead', style: Typo.heading, textAlign: TextAlign.center),
            ),
            Positioned(
              bottom: Space.x2,
              left: 0,
              right: 0,
              child: Center(child: ShutterButton(onPressed: _busy ? null : _captureFace)),
            ),
          ],
        );
      case _Step.voice:
        final phrase = _flow.nextPhrase;
        return Stack(
          fit: StackFit.expand,
          children: [
            Center(
              child: Padding(
                padding: const EdgeInsets.all(Space.x3),
                child: DataText(phrase ?? '', style: Typo.title, maxLines: 3, textAlign: TextAlign.center),
              ),
            ),
            Positioned(
              bottom: Space.x2,
              left: 0,
              right: 0,
              child: Center(
                child: ShutterButton(
                  semanticLabel: 'Record',
                  active: _recording,
                  onPressed: _busy ? null : _toggleRecord,
                ),
              ),
            ),
          ],
        );
      case _Step.idle:
        return const Center(child: Icon(LucideIcons.scanFace, size: 32, color: Palette.secondary));
    }
  }
}
