import 'json.dart';

/// `UserView` (CONTRACTS.md §12.2).
class UserView {
  const UserView({
    required this.id,
    required this.wallet,
    required this.displayName,
    required this.faceEnrolled,
    required this.voiceEnrolled,
  });

  final String id;
  final String wallet; // base58, never shown in primary UI
  final String displayName;
  final bool faceEnrolled;
  final bool voiceEnrolled;

  bool get enrolled => faceEnrolled && voiceEnrolled;

  factory UserView.fromJson(Object? v) {
    final j = asJson(v, 'UserView');
    final e = asJson(j['enrolled'], 'enrolled');
    return UserView(
      id: asString(j['id']),
      wallet: asString(j['wallet']),
      displayName: asString(j['display_name']),
      faceEnrolled: asBool(e['face']),
      voiceEnrolled: asBool(e['voice']),
    );
  }

  Json toJson() => {
        'id': id,
        'wallet': wallet,
        'display_name': displayName,
        'enrolled': {'face': faceEnrolled, 'voice': voiceEnrolled},
      };
}

/// `{token, user}` from `POST /auth/session`.
class Session {
  const Session({required this.token, required this.user});
  final String token;
  final UserView user;

  factory Session.fromJson(Object? v) {
    final j = asJson(v);
    return Session(token: asString(j['token']), user: UserView.fromJson(j['user']));
  }
}
