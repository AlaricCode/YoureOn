import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../api/api_error.dart';
import '../../capture/face_capture.dart';
import '../../capture/voice_capture.dart';
import '../../state/app_controller.dart';
import '../../state/app_scope.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/text.dart';
import 'enroll_flow.dart';

/// How long the check shows after each accepted photo / clip.
const Duration _snapShown = Duration(milliseconds: 700);

/// Shared state for the face and voice capture panels: busy flag, error
/// line and the per-capture check.
mixin _CapturePanel<T extends StatefulWidget> on State<T> {
  late final AppController app = AppScope.read(context);
  bool busy = false;
  String? error;
  bool snap = false;
  Timer? _snapTimer;

  Future<void> guard(Future<void> Function() f) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await f();
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } catch (_) {
      if (mounted) setState(() => error = ApiException('INTERNAL').message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void flashSnap() {
    _snapTimer?.cancel();
    setState(() => snap = true);
    _snapTimer = Timer(_snapShown, () {
      if (mounted) setState(() => snap = false);
    });
  }

  void disposeTimers() => _snapTimer?.cancel();

  /// The rounded stage (camera / phrase / start / saved) and the error line.
  Widget panel(Widget stage) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: ClipRRect(
            borderRadius: const BorderRadius.all(Radius.circular(12)),
            child: ColoredBox(
              color: Palette.surface,
              child: AnimatedSwitcher(duration: Motion.fast, switchInCurve: Motion.curve, child: stage),
            ),
          ),
        ),
        ErrorLine(error),
      ],
    );
  }

  Widget snapOverlay() => IgnorePointer(
        child: AnimatedOpacity(
          key: const ValueKey('enroll-snap'),
          opacity: snap ? 1 : 0,
          duration: Motion.fast,
          curve: Motion.curve,
          child: const Center(child: CheckBadge(size: 56, color: StageBubble.scrim)),
        ),
      );
}

// ---- face -------------------------------------------------------------------

/// Face step of Enroll: start → a series of photos (look ahead, then the
/// challenge's head turns) → checked by the backend → "Face saved".
/// Calls [onSaved] once the backend accepted the face.
class FaceCapturePanel extends StatefulWidget {
  const FaceCapturePanel({super.key, required this.flow, required this.onSaved});
  final EnrollFlow flow;
  final VoidCallback onSaved;

  @override
  State<FaceCapturePanel> createState() => _FaceCapturePanelState();
}

class _FaceCapturePanelState extends State<FaceCapturePanel> with _CapturePanel<FaceCapturePanel> {
  EnrollFlow get _flow => widget.flow;
  FaceCapture? _camera;

  @override
  void initState() {
    super.initState();
    // Open the camera as soon as the step shows; the system permission
    // prompt ("Allow Verdict to take pictures") appears here the first time.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_flow.faceDone) _open();
    });
  }

  @override
  void dispose() {
    disposeTimers();
    _camera?.close();
    super.dispose();
  }

  Future<void> _open() => guard(() async {
        await _flow.ensureChallenge();
        _flow.faceFrames.clear();
        final cam = app.newFaceCapture();
        try {
          await cam.open(front: true);
        } catch (_) {
          throw ApiException('NO_CAMERA');
        }
        if (!mounted) {
          await cam.close();
          return;
        }
        setState(() => _camera = cam);
      });

  Future<void> _capture() => guard(() async {
        final cam = _camera;
        if (cam == null) return;
        final frame = await cam.capture();
        final code = _flow.addFaceFrame(frame);
        if (code != null) throw ApiException(code);
        if (!_flow.faceReady) {
          if (mounted) flashSnap();
          return;
        }
        if (mounted) setState(() {}); // "Checking"
        await _flow.submitFace();
        await cam.close();
        if (!mounted) return;
        setState(() {
          _camera = null;
          snap = false;
        });
        widget.onSaved();
      });

  @override
  Widget build(BuildContext context) {
    if (_flow.faceDone) return panel(const SavedView(key: ValueKey('face-saved'), label: 'Face saved'));
    final cam = _camera;
    if (cam == null) {
      // Opening (spinner), or it failed (permission denied, no camera).
      return panel(StartView(
        key: const ValueKey('face-start'),
        icon: LucideIcons.scanFace,
        label: 'Try again',
        busy: busy || error == null,
        onPressed: _open,
      ));
    }
    final checking = _flow.faceReady;
    final prompt = _flow.nextFacePrompt;
    return panel(Stack(
      key: const ValueKey('face-stage'),
      fit: StackFit.expand,
      children: [
        if (cam.isOpen) cam.preview(),
        Positioned(
          top: Space.x2,
          left: Space.x2,
          right: Space.x2,
          child: Center(
            child: StageBubble(
              key: const ValueKey('face-progress'),
              prompt: prompt?.label ?? 'Look ahead',
              checking: checking,
            ),
          ),
        ),
        snapOverlay(),
        Positioned(
          bottom: Space.x2,
          left: 0,
          right: 0,
          child: Center(child: ShutterButton(onPressed: busy ? null : _capture)),
        ),
      ],
    ));
  }
}

// ---- voice ------------------------------------------------------------------

/// Voice step of Enroll: start → read each challenge phrase as a clip (tap to
/// record, tap to stop) → checked by the backend → "Voice saved".
/// Calls [onSaved] once the backend accepted the voice.
class VoiceCapturePanel extends StatefulWidget {
  const VoiceCapturePanel({super.key, required this.flow, required this.onSaved});
  final EnrollFlow flow;
  final VoidCallback onSaved;

  @override
  State<VoiceCapturePanel> createState() => _VoiceCapturePanelState();
}

class _VoiceCapturePanelState extends State<VoiceCapturePanel> with _CapturePanel<VoiceCapturePanel> {
  EnrollFlow get _flow => widget.flow;
  VoiceCapture? _mic;
  bool _recording = false;

  @override
  void initState() {
    super.initState();
    // Ask for the microphone as soon as the step shows; the system permission
    // prompt ("Allow Verdict to record audio") appears here the first time.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_flow.voiceDone) _open();
    });
  }

  @override
  void dispose() {
    disposeTimers();
    final mic = _mic;
    if (mic != null) {
      if (_recording) {
        mic.stop().whenComplete(mic.dispose);
      } else {
        mic.dispose();
      }
    }
    super.dispose();
  }

  Future<void> _open() => guard(() async {
        await _flow.ensureChallenge();
        _flow.voiceClips.clear();
        final mic = app.newVoiceCapture();
        if (!await mic.hasPermission()) {
          await mic.dispose();
          throw ApiException('PHRASE_NOT_HEARD');
        }
        if (!mounted) {
          await mic.dispose();
          return;
        }
        setState(() => _mic = mic);
      });

  Future<void> _toggleRecord() => guard(() async {
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
        if (!_flow.voiceReady) {
          if (mounted) flashSnap();
          return;
        }
        await _flow.submitVoice();
        if (!mounted) return;
        setState(() => snap = false);
        widget.onSaved();
      });

  @override
  Widget build(BuildContext context) {
    if (_flow.voiceDone) return panel(const SavedView(key: ValueKey('voice-saved'), label: 'Voice saved'));
    if (_mic == null) {
      // Opening (spinner), or it failed (permission denied).
      return panel(StartView(
        key: const ValueKey('voice-start'),
        icon: LucideIcons.mic,
        label: 'Try again',
        busy: busy || error == null,
        onPressed: _open,
      ));
    }
    final phrase = _flow.nextPhrase;
    final clips = _flow.challenge?.voicePhrases.length ?? 0;
    final checking = _flow.voiceReady;
    return panel(Stack(
      key: const ValueKey('voice-stage'),
      fit: StackFit.expand,
      children: [
        if (clips > 0)
          Positioned(
            top: Space.x2,
            left: Space.x2,
            right: Space.x2,
            child: Center(
              child: StageBubble(
                key: const ValueKey('voice-progress'),
                prompt: _recording ? 'Recording' : 'Tap, then read',
                checking: checking,
              ),
            ),
          ),
        Center(
          child: Padding(
            padding: const EdgeInsets.all(Space.x3),
            child: DataText(phrase ?? '', style: Typo.title, maxLines: 3, textAlign: TextAlign.center),
          ),
        ),
        snapOverlay(),
        Positioned(
          bottom: Space.x2,
          left: 0,
          right: 0,
          child: Center(
            child: ShutterButton(
              semanticLabel: 'Record',
              active: _recording,
              onPressed: busy ? null : _toggleRecord,
            ),
          ),
        ),
      ],
    ));
  }
}

// ---- shared widgets ---------------------------------------------------------

/// While the camera / microphone opens (button shows a spinner), or after it
/// could not open (permission denied): an icon and a retry button.
class StartView extends StatelessWidget {
  const StartView({super.key, required this.icon, required this.label, required this.onPressed, this.busy = false});
  final IconData icon;
  final String label;
  final VoidCallback onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Space.x3),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Icon(icon, size: 40, color: Palette.secondary),
            const SizedBox(height: Space.x3),
            QuietButton(label: label, busy: busy, onPressed: busy ? null : onPressed),
          ],
        ),
      ),
    );
  }
}

/// The confirmation shown once the backend accepted the step.
class SavedView extends StatelessWidget {
  const SavedView({super.key, required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CheckBadge(size: 72, color: Palette.accent),
          const SizedBox(height: Space.x2),
          Label(label, style: Typo.title),
        ],
      ),
    );
  }
}

/// A round badge with a check mark.
class CheckBadge extends StatelessWidget {
  const CheckBadge({super.key, required this.size, required this.color});
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      child: Icon(LucideIcons.check, size: size / 2, color: Palette.text),
    );
  }
}

/// Translucent bubble over the camera / phrase area with the current prompt
/// ("Turn left"), or an animated "Checking" while the backend verifies.
/// The scrim keeps the text readable over any camera image.
class StageBubble extends StatelessWidget {
  const StageBubble({super.key, required this.prompt, this.checking = false});

  final String prompt;
  final bool checking;

  /// Palette.background at ~80% opacity.
  static const Color scrim = Color(0xCC0B0B0C);

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: scrim,
        borderRadius: BorderRadius.all(Radius.circular(16)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: Space.x2, vertical: 10),
        child: checking
            ? const CheckingLabel(key: ValueKey('checking'))
            : Label(prompt, style: Typo.heading, textAlign: TextAlign.center),
      ),
    );
  }
}

/// "Checking" followed by dots that cycle . → .. → ... while it waits.
/// The dots sit in a fixed-width slot so the word does not shift.
class CheckingLabel extends StatefulWidget {
  const CheckingLabel({super.key});

  @override
  State<CheckingLabel> createState() => _CheckingLabelState();
}

class _CheckingLabelState extends State<CheckingLabel> {
  static const Duration _step = Duration(milliseconds: 400);
  Timer? _timer;
  int _dots = 1;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(_step, (_) {
      if (mounted) setState(() => _dots = _dots % 3 + 1);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Label('Checking', style: Typo.heading),
        SizedBox(
          width: 18,
          child: Text('.' * _dots, style: Typo.heading, maxLines: 1),
        ),
      ],
    );
  }
}
