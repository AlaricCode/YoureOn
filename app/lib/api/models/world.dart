import 'json.dart';

/// `WorldContract` / `WorldEvent` (CONTRACTS.md §11.1).
class WorldContract {
  const WorldContract({required this.id, required this.label, required this.probBps, this.bidBps, this.askBps});
  final String id;
  final String label;
  final int probBps;
  final int? bidBps;
  final int? askBps;

  factory WorldContract.fromJson(Object? v) {
    final j = asJson(v);
    return WorldContract(
      id: asString(j['id']),
      label: asString(j['label']),
      probBps: asInt(j['prob_bps']),
      bidBps: asIntOrNull(j['bid_bps']),
      askBps: asIntOrNull(j['ask_bps']),
    );
  }

  WorldContract withProb(int bps) =>
      WorldContract(id: id, label: label, probBps: bps, bidBps: bidBps, askBps: askBps);
}

class WorldResolution {
  const WorldResolution({required this.contractId, required this.result});
  final String contractId;
  final String result; // yes | no | void
}

class WorldEvent {
  const WorldEvent({
    required this.id,
    required this.title,
    required this.category,
    required this.closeTimeMs,
    required this.status,
    required this.contracts,
    this.resolution = const [],
  });

  final String id;
  final String title;
  final String category;
  final int closeTimeMs;
  final String status; // open | closed | resolved
  final List<WorldContract> contracts;
  final List<WorldResolution> resolution;

  factory WorldEvent.fromJson(Object? v) {
    final j = asJson(v, 'WorldEvent');
    return WorldEvent(
      id: asString(j['id']),
      title: asString(j['title']),
      category: asString(j['category']),
      closeTimeMs: asInt(j['close_time_ms']),
      status: asString(j['status']),
      contracts: asList(j['contracts'], WorldContract.fromJson),
      resolution: asList(j['resolution'], (e) {
        final r = asJson(e);
        return WorldResolution(contractId: asString(r['contract_id']), result: asString(r['result']));
      }),
    );
  }
}

/// One quote leg (request side + server-filled probability).
class QuoteLeg {
  const QuoteLeg({required this.eventId, required this.contractId, required this.side, this.probBps});
  final String eventId;
  final String contractId;
  final String side; // yes | no
  final int? probBps;

  Json toJson() => {'event_id': eventId, 'contract_id': contractId, 'side': side};

  factory QuoteLeg.fromJson(Object? v) {
    final j = asJson(v);
    return QuoteLeg(
      eventId: asString(j['event_id']),
      contractId: asString(j['contract_id']),
      side: asString(j['side']),
      probBps: asIntOrNull(j['prob_bps']),
    );
  }
}

/// `POST /world/quote` response.
class WorldQuote {
  const WorldQuote({
    required this.quoteId,
    required this.pBps,
    required this.proposerUnits,
    required this.counterpartyUnits,
    required this.legs,
    required this.expiresAtMs,
  });

  final String quoteId;
  final int pBps;
  final int proposerUnits;
  final int counterpartyUnits;
  final List<QuoteLeg> legs;
  final int expiresAtMs;

  factory WorldQuote.fromJson(Object? v) {
    final j = asJson(v);
    return WorldQuote(
      quoteId: asString(j['quote_id']),
      pBps: asInt(j['p_bps']),
      proposerUnits: asInt(j['proposer_units']),
      counterpartyUnits: asInt(j['counterparty_units']),
      legs: asList(j['legs'], QuoteLeg.fromJson),
      expiresAtMs: asInt(j['expires_at_ms']),
    );
  }
}

class LeaderboardRow {
  const LeaderboardRow({required this.userId, required this.displayName, required this.netUnits});
  final String userId;
  final String displayName;
  final int netUnits;

  factory LeaderboardRow.fromJson(Object? v) {
    final j = asJson(v);
    return LeaderboardRow(
      userId: asString(j['user_id']),
      displayName: asString(j['display_name']),
      netUnits: asInt(j['net_units']),
    );
  }
}
