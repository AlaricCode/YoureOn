import 'dart:typed_data';

import '../../api/api_client.dart';
import '../../api/api_error.dart';
import '../../api/models/identity.dart';
import '../../capture/face_capture.dart';

/// Pure state of the enrollment flow (CONTRACTS.md §12.3 enroll routes),
/// kept apart from widgets so it can be tested without a camera.
class EnrollFlow {
  EnrollFlow(this.api);

  final ApiClient api;

  EnrollChallenge? challenge;
  final List<Uint8List> faceFrames = [];
  final List<Uint8List> voiceClips = [];
  bool faceDone = false;
  bool voiceDone = false;
  bool consent = false;

  bool get canFinish => faceDone && voiceDone && consent;

  Future<EnrollChallenge> ensureChallenge() async => challenge ??= await api.enrollChallenge();

  /// Resets everything tied to the current challenge.
  void resetChallenge() {
    challenge = null;
    faceFrames.clear();
    voiceClips.clear();
    faceDone = false;
    voiceDone = false;
  }

  /// Face prompt for the next frame: null = neutral ("Look ahead"),
  /// then the challenge's two head-turn prompts in order.
  HeadPrompt? get nextFacePrompt {
    final c = challenge;
    final i = faceFrames.length;
    if (c == null || i == 0 || i > c.facePrompts.length) return null;
    return HeadPrompt.parse(c.facePrompts[i - 1]);
  }

  int get faceFramesNeeded => 1 + (challenge?.facePrompts.length ?? 2);

  /// Validates a captured frame against the current prompt; returns the
  /// §12.8 code to show, or null when the frame is accepted.
  String? addFaceFrame(CapturedFrame f) {
    final face = f.largestFace;
    if (face == null) return 'FACE_NOT_MATCHED';
    final p = nextFacePrompt;
    if (p != null && !p.satisfiedBy(face)) return 'LIVENESS_FAILED';
    faceFrames.add(f.jpeg);
    return null;
  }

  bool get faceReady => faceFrames.length >= faceFramesNeeded;

  /// `POST /enroll/face`. Throws [ApiException] on failure.
  Future<void> submitFace() async {
    final c = await ensureChallenge();
    try {
      final r = await api.enrollFace(c.challengeId, List.of(faceFrames));
      if (!r.ok || !r.liveness) {
        faceFrames.clear();
        throw ApiException('LIVENESS_FAILED');
      }
      faceDone = true;
    } on ApiException catch (e) {
      faceFrames.clear();
      if (e.code == 'CHALLENGE_EXPIRED') resetChallenge();
      rethrow;
    }
  }

  /// Phrase to read for the next clip.
  String? get nextPhrase {
    final c = challenge;
    if (c == null || voiceClips.length >= c.voicePhrases.length) return null;
    return c.voicePhrases[voiceClips.length];
  }

  bool get voiceReady => challenge != null && voiceClips.length >= challenge!.voicePhrases.length;

  /// `POST /enroll/voice`.
  Future<void> submitVoice() async {
    final c = await ensureChallenge();
    try {
      final ok = await api.enrollVoice(c.challengeId, List.of(voiceClips));
      if (!ok) throw ApiException('PHRASE_NOT_HEARD');
      voiceDone = true;
    } on ApiException catch (e) {
      voiceClips.clear();
      if (e.code == 'CHALLENGE_EXPIRED') resetChallenge();
      rethrow;
    }
  }
}
