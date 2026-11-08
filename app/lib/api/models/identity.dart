import 'json.dart';
import 'sign.dart';
import 'user.dart';

/// `GET /enroll/challenge` (CONTRACTS.md §12.3).
class EnrollChallenge {
  const EnrollChallenge({required this.challengeId, required this.facePrompts, required this.voicePhrases});
  final String challengeId;
  final List<String> facePrompts; // 2 of left | right | up | down
  final List<String> voicePhrases; // 3

  factory EnrollChallenge.fromJson(Object? v) {
    final j = asJson(v);
    return EnrollChallenge(
      challengeId: asString(j['challenge_id']),
      facePrompts: asStringList(j['face_prompts']),
      voicePhrases: asStringList(j['voice_phrases']),
    );
  }
}

class FaceEnrollResult {
  const FaceEnrollResult({required this.ok, required this.liveness});
  final bool ok;
  final bool liveness;

  factory FaceEnrollResult.fromJson(Object? v) {
    final j = asJson(v);
    return FaceEnrollResult(ok: asBool(j['ok']), liveness: asBool(j['liveness']));
  }
}

class EnrollComplete {
  const EnrollComplete({required this.faceCommit, required this.voiceCommit, required this.sign});
  final String faceCommit;
  final String voiceCommit;
  final SignRequest sign;

  factory EnrollComplete.fromJson(Object? v) {
    final j = asJson(v);
    return EnrollComplete(
      faceCommit: asString(j['face_commit']),
      voiceCommit: asString(j['voice_commit']),
      sign: SignRequest.fromJson(j['sign']),
    );
  }
}

/// `GET /pay/challenge`.
class PayChallenge {
  const PayChallenge({required this.challengeId, required this.facePrompt});
  final String challengeId;
  final String facePrompt;

  factory PayChallenge.fromJson(Object? v) {
    final j = asJson(v);
    return PayChallenge(challengeId: asString(j['challenge_id']), facePrompt: asString(j['face_prompt']));
  }
}

class PayMatch {
  const PayMatch({required this.user, required this.cosBps, required this.matched});
  final UserView? user;
  final int cosBps;
  final bool matched;

  factory PayMatch.fromJson(Object? v) {
    final j = asJson(v);
    return PayMatch(
      user: j['user'] == null ? null : UserView.fromJson(j['user']),
      cosBps: asInt(j['cos_bps']),
      matched: asBool(j['matched']),
    );
  }
}

/// `POST /pay/scan` / `POST /pay/voice`.
class PayScanResult {
  const PayScanResult({required this.matches, this.liveness});
  final List<PayMatch> matches;
  final bool? liveness;

  PayMatch? get best {
    for (final m in matches) {
      if (m.matched && m.user != null) return m;
    }
    return null;
  }

  factory PayScanResult.fromJson(Object? v) {
    final j = asJson(v);
    return PayScanResult(
      matches: asList(j['matches'], PayMatch.fromJson),
      liveness: j['liveness'] == null ? null : asBool(j['liveness']),
    );
  }
}
