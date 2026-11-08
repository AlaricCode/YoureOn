import 'json.dart';

/// Booth record (CONTRACTS.md §10.5). Exhibits and briefs are kept as raw
/// JSON; the app only shows the status and the ruling.
class BoothRecord {
  const BoothRecord({
    required this.status,
    required this.exhibits,
    required this.briefs,
    required this.commits,
    required this.reveals,
    required this.rulingOutcome,
    required this.rulingVotes,
    required this.txSignature,
  });

  final String status; // collecting | judging | ruled | submitted
  final List<Object?> exhibits;
  final Object? briefs;
  final List<BoothCommit> commits;
  final List<BoothReveal> reveals;
  final int? rulingOutcome;
  final Object? rulingVotes;
  final String? txSignature;

  factory BoothRecord.fromJson(Object? v) {
    final j = asJson(v, 'booth');
    final ruling = j['ruling'] == null ? null : asJson(j['ruling']);
    return BoothRecord(
      status: asString(j['status']),
      exhibits: j['exhibits'] is List ? List<Object?>.from(j['exhibits'] as List) : const [],
      briefs: j['briefs'],
      commits: asList(j['commits'], BoothCommit.fromJson),
      reveals: asList(j['reveals'], BoothReveal.fromJson),
      rulingOutcome: ruling == null ? null : asIntOrNull(ruling['outcome']),
      rulingVotes: ruling?['votes'],
      txSignature: asStringOrNull(j['tx_signature']),
    );
  }
}

class BoothCommit {
  const BoothCommit({required this.judge, required this.commit, required this.atMs});
  final int judge;
  final String commit;
  final int atMs;

  factory BoothCommit.fromJson(Object? v) {
    final j = asJson(v);
    return BoothCommit(judge: asInt(j['judge']), commit: asString(j['commit']), atMs: asInt(j['at_ms']));
  }
}

class BoothReveal {
  const BoothReveal({
    required this.judge,
    required this.outcome,
    required this.confidenceBps,
    required this.rationale,
  });
  final int judge;
  final int outcome;
  final int confidenceBps;
  final String rationale;

  factory BoothReveal.fromJson(Object? v) {
    final j = asJson(v);
    return BoothReveal(
      judge: asInt(j['judge']),
      outcome: asInt(j['outcome']),
      confidenceBps: asInt(j['confidence_bps']),
      rationale: asString(j['rationale']),
    );
  }
}
