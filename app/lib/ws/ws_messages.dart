import '../api/models/bet.dart';
import '../api/models/booth.dart';
import '../api/models/draft.dart';
import '../api/models/huddle.dart';
import '../api/models/json.dart';
import '../api/models/scene.dart';
import '../beacon/beacon.dart';

/// Server → client WebSocket messages (CONTRACTS.md §12.4).
sealed class WsMessage {
  const WsMessage();

  /// Parses one frame. Unknown types become [WsUnknown]; malformed known
  /// types throw [FormatException].
  factory WsMessage.fromJson(Object? v) {
    final j = asJson(v, 'ws message');
    switch (j['type']) {
      case 'bet':
        return WsBet(BetView.fromJson(j['bet']));
      case 'huddle':
        return WsHuddle(HuddleView.fromJson(j['huddle']));
      case 'draft':
        return WsDraft(asString(j['huddle_id']), DraftView.fromJson(j['draft']));
      case 'chain':
        return WsChain(
          betId: asString(j['bet_id']),
          name: asString(j['name']),
          data: j['data'] == null ? const {} : asJson(j['data']),
          signature: asStringOrNull(j['signature']),
          slot: j['slot'],
        );
      case 'scene':
        return WsScene(asString(j['bet_id']), SceneUpdate.fromJson(j));
      case 'start':
        return WsStart(
          betId: asString(j['bet_id']),
          beacon: Beacon.fromJson(asJson(j['beacon'])),
          wavUrl: asStringOrNull(j['wav_url']),
          sfxUrl: asStringOrNull(j['sfx_url']),
          playOnUserId: asStringOrNull(j['play_on_user_id']),
          playDelayMs: asIntOrNull(j['play_delay_ms']) ?? 1500,
        );
      case 'booth':
        return WsBooth(asString(j['bet_id']), BoothRecord.fromJson(j['booth']));
      case 'world.price':
        return WsWorldPrice(
          eventId: asString(j['event_id']),
          contractId: asString(j['contract_id']),
          probBps: asInt(j['prob_bps']),
          atMs: asIntOrNull(j['at_ms']),
        );
      case 'notify':
        return WsNotify(asString(j['title']), asStringOrNull(j['bet_id']));
      case 'pong':
        return const WsPong();
      default:
        return WsUnknown(j);
    }
  }
}

class WsBet extends WsMessage {
  const WsBet(this.bet);
  final BetView bet;
}

class WsHuddle extends WsMessage {
  const WsHuddle(this.huddle);
  final HuddleView huddle;
}

class WsDraft extends WsMessage {
  const WsDraft(this.huddleId, this.draft);
  final String huddleId;
  final DraftView draft;
}

class WsChain extends WsMessage {
  const WsChain({required this.betId, required this.name, required this.data, this.signature, this.slot});
  final String betId;
  final String name; // §9.5 event name
  final Json data;
  final String? signature;
  final Object? slot;
}

class WsScene extends WsMessage {
  const WsScene(this.betId, this.update);
  final String betId;
  final SceneUpdate update;
}

class WsStart extends WsMessage {
  const WsStart({
    required this.betId,
    required this.beacon,
    required this.wavUrl,
    required this.sfxUrl,
    required this.playOnUserId,
    required this.playDelayMs,
  });
  final String betId;
  final Beacon beacon;
  final String? wavUrl;
  final String? sfxUrl;
  final String? playOnUserId;
  final int playDelayMs;
}

class WsBooth extends WsMessage {
  const WsBooth(this.betId, this.booth);
  final String betId;
  final BoothRecord booth;
}

class WsWorldPrice extends WsMessage {
  const WsWorldPrice({required this.eventId, required this.contractId, required this.probBps, this.atMs});
  final String eventId;
  final String contractId;
  final int probBps;
  final int? atMs;
}

class WsNotify extends WsMessage {
  const WsNotify(this.title, this.betId);
  final String title; // ≤ 3 words
  final String? betId;
}

class WsPong extends WsMessage {
  const WsPong();
}

class WsUnknown extends WsMessage {
  const WsUnknown(this.json);
  final Json json;
}

/// Topic names.
abstract final class Topics {
  static const String user = 'user';
  static String bet(String id) => 'bet:$id';
  static String huddle(String id) => 'huddle:$id';
  static String world(String eventId) => 'world:$eventId';
}
