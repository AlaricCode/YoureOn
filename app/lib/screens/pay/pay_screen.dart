import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../api/api_error.dart';
import '../../api/models/identity.dart';
import '../../capture/face_capture.dart';
import '../../capture/image_utils.dart';
import '../../capture/voice_capture.dart';
import '../../contracts/constants.dart';
import '../../core/format.dart';
import '../../state/guarded.dart';
import '../../state/ws_watch.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/page.dart';
import '../../ui/widgets/text.dart';

/// The largest face of a frame as a JPEG crop (the whole frame if it can't
/// be cropped locally).
Uint8List largestFaceCrop(CapturedFrame f) {
  final face = f.largestFace;
  if (face == null) throw ApiException('FACE_NOT_MATCHED');
  try {
    return toUploadJpegSync(f.jpeg, crop: face.bbox).jpeg;
  } catch (_) {
    return f.jpeg;
  }
}

/// Pay (spec §3.2/§6.5, CONTRACTS.md §12.13): Camera · Name · Amount ·
/// Send, with a voice fallback when the face is not matched. The closed set
/// is the caller's recent huddle members (§8.3).
class PayScreen extends StatefulWidget {
  const PayScreen({super.key});

  @override
  State<PayScreen> createState() => _PayScreenState();
}

class _PayScreenState extends State<PayScreen> with Guarded, WsWatch {
  FaceCapture? _cam;
  VoiceCapture? _mic;
  PayChallenge? _challenge;
  Uint8List? _neutral;
  PayMatch? _match;
  bool _offerVoice = false;
  bool _recording = false;
  bool _sent = false;
  final _amount = TextEditingController();

  int? get _units {
    final u = parseUsd(_amount.text);
    return u == null || u < MIN_STAKE_UNITS ? null : u;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _open());
  }

  @override
  void dispose() {
    _cam?.close();
    _mic?.dispose();
    _amount.dispose();
    super.dispose();
  }

  Future<void> _open() => guard('open', () async {
        final cam = _cam ??= app.newFaceCapture();
        try {
          await cam.open(front: false);
        } catch (_) {
          _offerVoice = true;
          throw ApiException('NO_CAMERA');
        }
        await _newChallenge();
      });

  Future<void> _newChallenge() async {
    final c = await app.api.payChallenge();
    if (mounted) {
      setState(() {
        _challenge = c;
        _neutral = null;
      });
    }
  }

  Future<void> _shutter() => guard('scan', () async {
        final cam = _cam;
        final c = _challenge;
        if (cam == null || c == null) return;
        final frame = await cam.capture();
        final crop = largestFaceCrop(frame);
        if (_neutral == null) {
          if (mounted) setState(() => _neutral = crop);
          return;
        }
        final neutral = _neutral!;
        try {
          final r = await app.api.payScan(c.challengeId, neutral: neutral, prompted: crop);
          if (r.liveness == false) throw ApiException('LIVENESS_FAILED');
          final best = r.best;
          if (best == null) {
            _offerVoice = true;
            throw ApiException('FACE_NOT_MATCHED');
          }
          if (mounted) setState(() => _match = best);
        } finally {
          // A challenge is single-use.
          await _newChallenge();
        }
      });

  Future<void> _voice() async {
    if (!_recording) {
      await guard('voice', () async {
        final mic = _mic ??= app.newVoiceCapture();
        if (!await mic.hasPermission()) throw ApiException('PHRASE_NOT_HEARD');
        await mic.start();
        if (mounted) setState(() => _recording = true);
      });
      return;
    }
    await guard('voice-match', () async {
      final wav = await _mic!.stop();
      if (mounted) setState(() => _recording = false);
      final best = (await app.api.payVoice(wav)).best;
      if (best == null) throw ApiException('VOICE_NOT_MATCHED');
      if (mounted) setState(() => _match = best);
    });
  }

  void _rescan() => setState(() {
        _match = null;
        _sent = false;
      });

  Future<void> _send() => guard('send', () async {
        final to = _match!.user!;
        final units = _units!;
        await app.tx.run(() => app.api.pay(toUserId: to.id, amountUnits: units), fresh: true);
        if (mounted) setState(() => _sent = true);
        try {
          await app.refreshHome();
        } on ApiException {
          // Balance refreshes on the next Home load.
        }
      });

  @override
  Widget build(BuildContext context) {
    final match = _match;
    return AppPage(
      title: 'Pay',
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ErrorLine(error),
          if (_sent)
            const QuietButton(label: 'Sent', onPressed: null)
          else
            PrimaryButton(
              label: 'Send',
              busy: busyWith('send'),
              onPressed: match != null && _units != null && !busy ? _send : null,
            ),
        ],
      ),
      child: ListView(children: [
        const SizedBox(height: Space.x1),
        if (match == null) _camera() else _name(match),
        const SizedBox(height: Space.x2),
        TextField(
          key: const ValueKey('pay-amount'),
          controller: _amount,
          enabled: !_sent,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          style: Typo.title,
          decoration: const InputDecoration(hintText: 'Amount', prefixText: r'$'),
          onChanged: (_) => setState(() {}),
        ),
        if (_offerVoice && match == null) ...[
          const SizedBox(height: Space.x2),
          QuietButton(
            label: _recording ? 'Stop' : 'Voice',
            busy: busyWith('voice-match'),
            onPressed: busy && !_recording ? null : _voice,
          ),
        ],
      ]),
    );
  }

  Widget _name(PayMatch m) {
    return SizedBox(
      height: Space.x8 + Space.x4,
      child: Row(children: [
        const Icon(LucideIcons.user, size: 20, color: Palette.secondary),
        const SizedBox(width: Space.x2),
        Expanded(child: DataText(m.user!.displayName, key: const ValueKey('pay-name'), style: Typo.title)),
        if (!_sent) AppChip(label: 'Change', onTap: busy ? null : _rescan),
      ]),
    );
  }

  Widget _camera() {
    final cam = _cam;
    final prompt = _challenge == null ? null : HeadPrompt.parse(_challenge!.facePrompt);
    return AspectRatio(
      aspectRatio: 3 / 4,
      child: ClipRRect(
        borderRadius: const BorderRadius.all(Radius.circular(12)),
        child: ColoredBox(
          color: Palette.surface,
          child: Stack(fit: StackFit.expand, children: [
            if (cam != null && cam.isOpen)
              cam.preview()
            else
              const Center(child: Icon(LucideIcons.scanFace, size: 32, color: Palette.secondary)),
            Positioned(
              top: Space.x2,
              left: 0,
              right: 0,
              child: Label(
                _neutral == null ? 'Look ahead' : (prompt?.label ?? ''),
                style: Typo.heading,
                textAlign: TextAlign.center,
              ),
            ),
            Positioned(
              bottom: Space.x2,
              left: 0,
              right: 0,
              child: Center(
                child: ShutterButton(
                  semanticLabel: 'Capture',
                  onPressed: cam != null && cam.isOpen && _challenge != null && !busy ? _shutter : null,
                ),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}
