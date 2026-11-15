import 'json.dart';
import 'user.dart';

class HuddleMember {
  const HuddleMember({required this.user, required this.joinedAtMs, required this.confirmed});
  final UserView user;
  final int joinedAtMs;
  final bool confirmed;

  factory HuddleMember.fromJson(Object? v) {
    final j = asJson(v, 'member');
    return HuddleMember(
      user: UserView.fromJson(j['user']),
      joinedAtMs: asInt(j['joined_at_ms']),
      confirmed: asBool(j['confirmed']),
    );
  }
}

/// `HuddleView` (CONTRACTS.md §12.2).
class HuddleView {
  const HuddleView({
    required this.id,
    required this.code,
    required this.creatorUserId,
    required this.members,
  });

  final String id;
  final String code;
  final String creatorUserId;
  final List<HuddleMember> members;

  List<HuddleMember> get confirmed => members.where((m) => m.confirmed).toList();

  factory HuddleView.fromJson(Object? v) {
    final j = asJson(v, 'HuddleView');
    return HuddleView(
      id: asString(j['id']),
      code: asString(j['code']),
      creatorUserId: asString(j['creator_user_id']),
      members: asList(j['members'], HuddleMember.fromJson),
    );
  }
}

/// `POST /huddles` → `{huddle_id, code}`.
class HuddleCreated {
  const HuddleCreated({required this.huddleId, required this.code});
  final String huddleId;
  final String code;

  factory HuddleCreated.fromJson(Object? v) {
    final j = asJson(v);
    return HuddleCreated(huddleId: asString(j['huddle_id']), code: asString(j['code']));
  }
}

/// One face sent to `POST /huddles/:id/scan`.
class FaceCrop {
  const FaceCrop({required this.cropB64, required this.bbox});
  final String cropB64; // JPEG
  final List<int> bbox; // [x0,y0,x1,y1], normalized 0..10000

  Json toJson() => {'crop_b64': cropB64, 'bbox': bbox};
}

class FaceMatch {
  const FaceMatch({required this.bbox, required this.user, required this.cosBps, required this.matched});
  final List<int> bbox;
  final UserView? user;
  final int cosBps;
  final bool matched;

  factory FaceMatch.fromJson(Object? v) {
    final j = asJson(v);
    return FaceMatch(
      bbox: asIntList(j['bbox']),
      user: j['user'] == null ? null : UserView.fromJson(j['user']),
      cosBps: asInt(j['cos_bps']),
      matched: asBool(j['matched']),
    );
  }
}
