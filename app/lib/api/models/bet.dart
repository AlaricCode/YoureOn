import 'calibration.dart';
import 'json.dart';
import 'program.dart';

enum BetState {
  proposed('proposed'),
  funded('funded'),
  live('live'),
  perceiving('perceiving'),
  preruled('preruled'),
  disputed('disputed'),
  settled('settled'),
  refunded('refunded');

  const BetState(this.wire);
  final String wire;

  bool get terminal => this == settled || this == refunded;

  static BetState parse(Object? v) => enumByWire(values, v, (e) => e.wire);
}

enum Consent {
  pending('pending'),
  agree('agree'),
  dispute('dispute');

  const Consent(this.wire);
  final String wire;
}

class ParticipantView {
  const ParticipantView({
    required this.userId,
    required this.displayName,
    required this.wallet,
    required this.side,
    required this.accepted,
    required this.funded,
    required this.consent,
  });

  final String userId;
  final String displayName;
  final String wallet;
  final int side;
  final bool accepted;
  final bool funded;
  final Consent consent;

  factory ParticipantView.fromJson(Object? v) {
    final j = asJson(v, 'ParticipantView');
    return ParticipantView(
      userId: asString(j['user_id']),
      displayName: asString(j['display_name']),
      wallet: asString(j['wallet']),
      side: asInt(j['side']),
      accepted: asBool(j['accepted']),
      funded: asBool(j['funded']),
      consent: enumByWire(Consent.values, j['consent'], (e) => e.wire),
    );
  }
}

/// A condition row descriptor (§12.10).
class ConditionRef {
  const ConditionRef({required this.leg, required this.field, required this.path, required this.label});
  final int leg;
  final String field; // valid_attempt | success
  final String path;
  final String label;

  String get key => '$leg/$field/$path';

  factory ConditionRef.fromJson(Object? v) {
    final j = asJson(v);
    return ConditionRef(
      leg: asInt(j['leg']),
      field: asString(j['field']),
      path: asString(j['path']),
      label: asString(j['label']),
    );
  }
}

class Deadlines {
  const Deadlines({this.fund, this.start, this.liveEnd, this.consent, this.panel});
  final int? fund;
  final int? start;
  final int? liveEnd;
  final int? consent;
  final int? panel;

  factory Deadlines.fromJson(Object? v) {
    if (v == null) return const Deadlines();
    final j = asJson(v);
    return Deadlines(
      fund: asIntOrNull(j['fund']),
      start: asIntOrNull(j['start']),
      liveEnd: asIntOrNull(j['live_end']),
      consent: asIntOrNull(j['consent']),
      panel: asIntOrNull(j['panel']),
    );
  }
}

class WitnessView {
  const WitnessView({required this.id, required this.label, required this.kind, this.userId, this.synced});
  final String id;
  final String label;
  final String kind; // camera | audio | detections
  final String? userId;
  final bool? synced;

  factory WitnessView.fromJson(Object? v) {
    final j = asJson(v);
    return WitnessView(
      id: asString(j['id']),
      label: asString(j['label']),
      kind: asString(j['kind']),
      userId: asStringOrNull(j['user_id']),
      synced: j['synced'] == null ? null : asBool(j['synced']),
    );
  }
}

class PreRuling {
  const PreRuling({
    required this.code,
    required this.reason,
    required this.winnerSide,
    required this.winnerMask,
    required this.legResults,
    required this.consentDeadlineMs,
  });

  final int code; // 1 | 2 | 3
  final int reason;
  final int? winnerSide;
  final int winnerMask;
  final List<int> legResults;
  final int? consentDeadlineMs;

  factory PreRuling.fromJson(Object? v) {
    final j = asJson(v);
    return PreRuling(
      code: asInt(j['code']),
      reason: asInt(j['reason']),
      winnerSide: asIntOrNull(j['winner_side']),
      winnerMask: asInt(j['winner_mask']),
      legResults: asIntList(j['leg_results']),
      consentDeadlineMs: asIntOrNull(j['consent_deadline_ms']),
    );
  }
}

class DisputeView {
  const DisputeView({required this.byUserId, required this.reason, required this.bondUnits});
  final String? byUserId;
  final int reason;
  final int bondUnits;

  factory DisputeView.fromJson(Object? v) {
    final j = asJson(v);
    return DisputeView(
      byUserId: asStringOrNull(j['by_user_id']),
      reason: asInt(j['reason']),
      bondUnits: asInt(j['bond_units']),
    );
  }
}

class Payout {
  const Payout({required this.userId, required this.amountUnits});
  final String userId;
  final int amountUnits;

  factory Payout.fromJson(Object? v) {
    final j = asJson(v);
    return Payout(userId: asString(j['user_id']), amountUnits: asInt(j['amount_units']));
  }
}

class SettlementView {
  const SettlementView({required this.path, required this.winnerMask, required this.payouts, required this.txSignature});
  final String path; // consent | rule | panel | refund
  final int winnerMask;
  final List<Payout> payouts;
  final String txSignature;

  factory SettlementView.fromJson(Object? v) {
    final j = asJson(v);
    return SettlementView(
      path: asString(j['path']),
      winnerMask: asInt(j['winner_mask']),
      payouts: asList(j['payouts'], Payout.fromJson),
      txSignature: asString(j['tx_signature']),
    );
  }
}

/// `BetView` (CONTRACTS.md §12.2).
class BetView {
  const BetView({
    required this.id,
    required this.title,
    required this.kind,
    required this.aiJudged,
    required this.state,
    required this.stateLabel,
    required this.creatorUserId,
    required this.participants,
    required this.myIndex,
    required this.myRole,
    required this.stakeEachUnits,
    required this.stakesUnits,
    required this.potUnits,
    required this.timeLimitS,
    required this.actorBound,
    required this.program,
    required this.yaml,
    required this.readback,
    required this.programHash,
    required this.labels,
    required this.calibration,
    required this.calibrationHash,
    required this.conditions,
    required this.deadlines,
    required this.startedAtMs,
    required this.t0Ms,
    required this.endedAtMs,
    required this.witnesses,
    required this.gapMask,
    required this.preruling,
    required this.dispute,
    required this.boothStatus,
    required this.settlement,
    required this.refundReason,
    required this.updatedAtMs,
  });

  final String id; // Bet PDA, base58
  final String title;
  final ProgramKind kind;
  final bool aiJudged;
  final BetState state;
  final String stateLabel;
  final String creatorUserId;
  final List<ParticipantView> participants;
  final int? myIndex;
  final String myRole; // participant | bystander
  final int? stakeEachUnits;
  final List<int> stakesUnits;
  final int potUnits;
  final int timeLimitS;
  final bool actorBound;
  final Program program;
  final String yaml;
  final List<String> readback;
  final String programHash;
  final Map<String, String> labels;
  final Calibration? calibration;
  final String? calibrationHash;
  final List<ConditionRef> conditions;
  final Deadlines deadlines;
  final int? startedAtMs;
  final int? t0Ms;
  final int? endedAtMs;
  final List<WitnessView> witnesses;
  final int gapMask;
  final PreRuling? preruling;
  final DisputeView? dispute;
  final String? boothStatus;
  final SettlementView? settlement;
  final int? refundReason;
  final int updatedAtMs;

  bool get isParticipant => myRole == 'participant' && myIndex != null;
  ParticipantView? get me => isParticipant ? participants[myIndex!] : null;

  /// My stake in USDC units (null for bystanders).
  int? get myStakeUnits {
    final i = myIndex;
    if (i == null) return null;
    if (i < stakesUnits.length) return stakesUnits[i];
    return stakeEachUnits;
  }

  factory BetView.fromJson(Object? v) {
    final j = asJson(v, 'BetView');
    return BetView(
      id: asString(j['id']),
      title: asString(j['title']),
      kind: ProgramKind.parse(j['kind']),
      aiJudged: asBool(j['ai_judged']),
      state: BetState.parse(j['state']),
      stateLabel: asString(j['state_label']),
      creatorUserId: asString(j['creator_user_id']),
      participants: asList(j['participants'], ParticipantView.fromJson),
      myIndex: asIntOrNull(j['my_index']),
      myRole: asString(j['my_role']),
      stakeEachUnits: asIntOrNull(j['stake_each_units']),
      stakesUnits: asIntList(j['stakes_units']),
      potUnits: asInt(j['pot_units']),
      timeLimitS: asInt(j['time_limit_s']),
      actorBound: asBool(j['actor_bound']),
      program: Program.fromJson(j['program']),
      yaml: asString(j['yaml']),
      readback: asStringList(j['readback']),
      programHash: asString(j['program_hash']),
      labels: asStringMap(j['labels']),
      calibration: j['calibration'] == null ? null : Calibration.fromJson(j['calibration']),
      calibrationHash: asStringOrNull(j['calibration_hash']),
      conditions: asList(j['conditions'], ConditionRef.fromJson),
      deadlines: Deadlines.fromJson(j['deadlines_ms']),
      startedAtMs: asIntOrNull(j['started_at_ms']),
      t0Ms: asIntOrNull(j['t0_ms']),
      endedAtMs: asIntOrNull(j['ended_at_ms']),
      witnesses: asList(j['witnesses'], WitnessView.fromJson),
      gapMask: asInt(j['gap_mask']),
      preruling: j['preruling'] == null ? null : PreRuling.fromJson(j['preruling']),
      dispute: j['dispute'] == null ? null : DisputeView.fromJson(j['dispute']),
      boothStatus: asStringOrNull(j['booth_status']),
      settlement: j['settlement'] == null ? null : SettlementView.fromJson(j['settlement']),
      refundReason: asIntOrNull(j['refund_reason']),
      updatedAtMs: asInt(j['updated_at_ms']),
    );
  }
}
