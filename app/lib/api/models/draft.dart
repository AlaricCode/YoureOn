import 'json.dart';
import 'program.dart';

enum QuestionKind {
  choice('choice'),
  multi('multi'),
  free('free'),
  region('region');

  const QuestionKind(this.wire);
  final String wire;
}

/// `Question` (CONTRACTS.md §12.2). `text` is at most 6 words and is spoken
/// via `audio_url`; the UI shows only its chips.
class Question {
  const Question({
    required this.id,
    required this.text,
    required this.kind,
    required this.chips,
    this.entity,
    this.audioUrl,
  });

  final String id;
  final String text;
  final QuestionKind kind;
  final List<String> chips;
  final String? entity;
  final String? audioUrl;

  factory Question.fromJson(Object? v) {
    final j = asJson(v, 'Question');
    return Question(
      id: asString(j['id']),
      text: asString(j['text']),
      kind: enumByWire(QuestionKind.values, j['kind'], (e) => e.wire),
      chips: asStringList(j['chips']),
      entity: asStringOrNull(j['entity']),
      audioUrl: asStringOrNull(j['audio_url']),
    );
  }
}

class DraftParticipant {
  const DraftParticipant({
    required this.userId,
    required this.displayName,
    required this.side,
    required this.accepted,
    required this.isCreator,
  });

  final String userId;
  final String displayName;
  final int side;
  final bool accepted;
  final bool isCreator;

  factory DraftParticipant.fromJson(Object? v) {
    final j = asJson(v);
    return DraftParticipant(
      userId: asString(j['user_id']),
      displayName: asString(j['display_name']),
      side: asInt(j['side']),
      accepted: asBool(j['accepted']),
      isCreator: asBool(j['is_creator']),
    );
  }
}

enum DraftStatus {
  needsClarification('needs_clarification'),
  ready('ready'),
  invalid('invalid');

  const DraftStatus(this.wire);
  final String wire;
}

/// `DraftView` (§12.2).
class DraftView {
  const DraftView({
    required this.draftId,
    required this.huddleId,
    required this.status,
    required this.kind,
    required this.title,
    required this.questions,
    required this.labels,
    required this.participants,
    required this.frozen,
    required this.readbackAudioUrl,
    required this.updatedAtMs,
    this.program,
    this.yaml,
    this.readback,
    this.programHash,
    this.betId,
    this.errors = const [],
    this.warnings = const [],
  });

  final String draftId;
  final String huddleId;
  final DraftStatus status;
  final ProgramKind kind;
  final String? title;
  final List<Question> questions;
  final Program? program;
  final String? yaml;
  final List<String>? readback;
  final String? programHash;

  /// The bet created from this draft, once `create_bet` confirmed
  /// (errata: lets every huddle member, bystanders included, follow the
  /// creator from Terms).
  final String? betId;
  final Map<String, String> labels;
  final List<DraftParticipant> participants;
  final List<CompileError> errors;
  final List<CompileError> warnings;
  final bool frozen;
  final String? readbackAudioUrl;
  final int updatedAtMs;

  bool get allCounterpartiesAccepted =>
      participants.where((p) => !p.isCreator).every((p) => p.accepted);

  factory DraftView.fromJson(Object? v) {
    final j = asJson(v, 'DraftView');
    return DraftView(
      draftId: asString(j['draft_id']),
      huddleId: asString(j['huddle_id']),
      status: enumByWire(DraftStatus.values, j['status'], (e) => e.wire),
      kind: ProgramKind.parse(j['kind']),
      title: asStringOrNull(j['title']),
      questions: asList(j['questions'], Question.fromJson),
      program: j['program'] == null ? null : Program.fromJson(j['program']),
      yaml: asStringOrNull(j['yaml']),
      readback: j['readback'] == null ? null : asStringList(j['readback']),
      programHash: asStringOrNull(j['program_hash']),
      betId: asStringOrNull(j['bet_id']),
      labels: asStringMap(j['labels']),
      participants: asList(j['participants'], DraftParticipant.fromJson),
      errors: asList(j['errors'], CompileError.fromJson),
      warnings: asList(j['warnings'], CompileError.fromJson),
      frozen: asBool(j['frozen']),
      readbackAudioUrl: asStringOrNull(j['readback_audio_url']),
      updatedAtMs: asInt(j['updated_at_ms']),
    );
  }
}

/// `GET /drafts/:id/accept/challenge`.
class AcceptChallenge {
  const AcceptChallenge({required this.challengeId, required this.phrase});
  final String challengeId;
  final String phrase; // "I accept <w1> <w2>"

  factory AcceptChallenge.fromJson(Object? v) {
    final j = asJson(v);
    return AcceptChallenge(challengeId: asString(j['challenge_id']), phrase: asString(j['phrase']));
  }
}

class AcceptResult {
  const AcceptResult({required this.accepted, required this.cosBps, required this.participantIndex});
  final bool accepted;
  final int cosBps;
  final int participantIndex;

  factory AcceptResult.fromJson(Object? v) {
    final j = asJson(v);
    return AcceptResult(
      accepted: asBool(j['accepted']),
      cosBps: asInt(j['cos_bps']),
      participantIndex: asInt(j['participant_index']),
    );
  }
}

/// `POST /agent/session`.
class AgentSession {
  const AgentSession({required this.mode, this.signedUrl});
  final String mode; // mock | elevenlabs
  final String? signedUrl;

  factory AgentSession.fromJson(Object? v) {
    final j = asJson(v);
    return AgentSession(mode: asString(j['mode']), signedUrl: asStringOrNull(j['signed_url']));
  }
}
