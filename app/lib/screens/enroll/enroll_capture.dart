import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../api/api_error.dart';
import '../../capture/capture_permissions.dart';
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

  /// Camera / microphone access: null while the system prompt is up.
  DeviceAccess? access;

  /// Asks for [device] (the system prompt shows right away the first time).
  /// Returns true when allowed; otherwise the stage shows the "allow" state.
  Future<bool> ensureAccess(CaptureDevice device) async {
    if (mounted) setState(() => access = null);
    final a = await CapturePermissions.instance.request(device);
    if (mounted) setState(() => access = a);
    return a == DeviceAccess.granted;
  }

  /// Back from the system settings: if access was turned on there, start.
  Future<void> recheckAccess(CaptureDevice device, VoidCallback start) async {
    if (access == DeviceAccess.granted || access == null) return;
    final a = await CapturePermissions.instance.status(device);
    if (!mounted) return;
    setState(() => access = a);
    if (a == DeviceAccess.granted) start();
  }

  /// The stage before the camera / microphone runs: waiting for the prompt,
  /// denied (ask again), blocked (open settings), or opening / failed.
  Widget accessStage({
    required CaptureDevice device,
    required IconData icon,
    required VoidCallback onRetry,
  }) {
    final cam = device == CaptureDevice.camera;
    return switch (access) {
      null => _AccessView(
          key: const ValueKey('access-asking'),
          icon: icon,
          label: cam ? 'Allow camera access' : 'Allow microphone access',
        ),
      DeviceAccess.denied => _AccessView(
          key: const ValueKey('access-denied'),
          icon: icon,
          button: QuietButton(label: cam ? 'Allow camera' : 'Allow microphone', onPressed: onRetry),
        ),
      DeviceAccess.blocked => _AccessView(
          key: const ValueKey('access-blocked'),
          icon: icon,
          button: QuietButton(label: 'Open settings', onPressed: CapturePermissions.instance.openSettings),
        ),
      DeviceAccess.granted => StartView(
          key: const ValueKey('access-start'),
          icon: icon,
          label: 'Try again',
          busy: busy || error == null,
          onPressed: onRetry,
        ),
    };
  }

  /// The red line under the stage: a capture problem, or missing access.
  String? alertFor(CaptureDevice device) => switch (access) {
        DeviceAccess.denied || DeviceAccess.blocked =>
          device == CaptureDevice.camera ? 'Camera access needed' : 'Microphone access needed',
        _ => error,
      };

  Future<void> guard(Future<void> Function() f) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await f();
    } on ApiException catch (e) {
      // The full error (code, HTTP status, the backend's message) goes to the
      // `flutter run` console; the user sees the short line.
      debugPrint('enroll capture failed: $e');
      if (mounted) setState(() => error = describe(e));
    } catch (e) {
      debugPrint('enroll capture failed: $e');
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

  /// The line shown for a failed capture; panels override it to say what to
  /// fix ("No face found") instead of the generic §12.8 message.
  String describe(ApiException e) => e.message;

  /// The rounded stage (camera / phrase / start / saved) and the error line.
  Widget panel(Widget stage, {String? alert}) {
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
        _AlertLine(alert ?? error),
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

class _FaceCapturePanelState extends State<FaceCapturePanel>
    with _CapturePanel<FaceCapturePanel>, WidgetsBindingObserver {
  EnrollFlow get _flow => widget.flow;
  FaceCapture? _camera;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Ask for the camera as soon as the step shows: the system prompt
    // ("Allow Verdict to take pictures") appears right away the first time.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_flow.faceDone) _open();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    disposeTimers();
    _camera?.close();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _camera == null && !_flow.faceDone) {
      recheckAccess(CaptureDevice.camera, _open);
    }
  }

  Future<void> _open() => guard(() async {
        if (!await ensureAccess(CaptureDevice.camera)) return;
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
        _flow.faceFrames.clear();
        setState(() => _camera = cam);
        // The prompts come from the backend; fetched once the camera shows.
        await _flow.ensureChallenge();
        if (mounted) setState(() {});
      });

  @override
  String describe(ApiException e) => switch (e.code) {
        // On-device detector or the backend's face model found no face.
        'FACE_NOT_MATCHED' => 'No face found',
        // Backend: the photos do not look like the same person; start over.
        'LIVENESS_FAILED' => "Photos didn't match",
        _ => e.message,
      };

  Future<void> _capture() => guard(() async {
        final cam = _camera;
        if (cam == null) return;
        final frame = await cam.capture();
        final code = _flow.addFaceFrame(frame);
        if (code == 'LIVENESS_FAILED') {
          // Head not turned far enough: say which way, keep the photos so far.
          final p = _flow.nextFacePrompt;
          if (mounted) setState(() => error = p?.furtherLabel ?? 'Turn further');
          return;
        }
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
      return panel(
        accessStage(device: CaptureDevice.camera, icon: LucideIcons.scanFace, onRetry: _open),
        alert: alertFor(CaptureDevice.camera),
      );
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

class _VoiceCapturePanelState extends State<VoiceCapturePanel>
    with _CapturePanel<VoiceCapturePanel>, WidgetsBindingObserver {
  EnrollFlow get _flow => widget.flow;
  VoiceCapture? _mic;
  bool _recording = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Ask for the microphone as soon as the step shows: the system prompt
    // ("Allow Verdict to record audio") appears right away the first time.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_flow.voiceDone) _open();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _mic == null && !_flow.voiceDone) {
      recheckAccess(CaptureDevice.microphone, _open);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
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
        if (!await ensureAccess(CaptureDevice.microphone)) return;
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
      return panel(
        accessStage(device: CaptureDevice.microphone, icon: LucideIcons.mic, onRetry: _open),
        alert: alertFor(CaptureDevice.microphone),
      );
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
                recording: _recording,
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
/// could not open: an icon and a retry button.
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
  const StageBubble({super.key, required this.prompt, this.checking = false, this.recording = false});

  final String prompt;
  final bool checking;

  /// The microphone is on: red text with a red dot.
  final bool recording;

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
            : recording
                ? Row(
                    key: const ValueKey('recording'),
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 8,
                        height: 8,
                        decoration: const BoxDecoration(color: Palette.danger, shape: BoxShape.circle),
                      ),
                      const SizedBox(width: Space.x1),
                      Label(prompt, style: Typo.heading.copyWith(color: Palette.danger)),
                    ],
                  )
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

/// A capture problem the user can fix, in red, in the same slot (and height)
/// as [ErrorLine] so the layout does not jump.
class _AlertLine extends StatelessWidget {
  const _AlertLine(this.message);
  final String? message;

  @override
  Widget build(BuildContext context) {
    final m = message;
    return AnimatedSwitcher(
      duration: Motion.fast,
      switchInCurve: Motion.curve,
      child: m == null
          ? const SizedBox(height: Space.x3)
          : SizedBox(
              key: ValueKey(m),
              height: Space.x3,
              child: Center(child: Label(m, style: Typo.label.copyWith(color: Palette.danger))),
            ),
    );
  }
}

/// The stage before capture can start: the device icon with either a quiet
/// label (waiting for the system prompt) or a button (ask again / settings).
class _AccessView extends StatelessWidget {
  const _AccessView({super.key, required this.icon, this.label, this.button});
  final IconData icon;
  final String? label;
  final Widget? button;

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
            if (label != null) Label(label!, style: Typo.label.copyWith(color: Palette.secondary), textAlign: TextAlign.center),
            if (button != null) button!,
          ],
        ),
      ),
    );
  }
}
