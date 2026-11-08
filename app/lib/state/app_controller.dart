import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../api/api_client.dart';
import '../api/api_error.dart';
import '../api/models/bet.dart';
import '../api/models/user.dart';
import '../api/transport.dart';
import '../beacon/beacon_player.dart';
import '../capture/face_capture.dart';
import '../capture/pose.dart';
import '../capture/scene_camera.dart';
import '../capture/voice_capture.dart';
import '../evidence/witness_runner.dart';
import '../evidence/witness_session.dart';
import '../media/audio_out.dart';
import '../media/links.dart';
import '../wallet/key_store.dart';
import '../wallet/tx_signer.dart';
import '../wallet/wallet.dart';
import '../wallet/witness_keys.dart';
import '../ws/ws_client.dart';
import '../ws/ws_messages.dart';
import 'config.dart';

/// App-wide services and session state.
class AppController extends ChangeNotifier {
  AppController({
    required this.config,
    required KeyStore keyStore,
    required Authenticator authenticator,
    http.Client? httpClient,
    ChannelFactory? wsConnect,
    FaceCapture Function()? faceCapture,
    VoiceCapture Function()? voiceCapture,
    SceneCamera Function()? sceneCamera,
    PoseSource Function()? poseSource,
    WitnessRunner Function(String betId)? witnessRunner,
    StartSignal Function()? startSignal,
    AudioOut? audioOut,
    LinkOpener? linkOpener,
  })  : store = keyStore,
        transport = ApiTransport(baseUrl: config.apiBaseUrl, client: httpClient),
        _wsConnect = wsConnect,
        newFaceCapture = faceCapture ?? CameraFaceCapture.new,
        newVoiceCapture = voiceCapture ?? MicVoiceCapture.new,
        newSceneCamera = sceneCamera ?? DeviceSceneCamera.new,
        newPoseSource = poseSource ?? SensorPoseSource.new,
        _witnessRunner = witnessRunner,
        _startSignal = startSignal,
        _audioOut = audioOut,
        openLink = linkOpener ?? openExternal {
    api = ApiClient(transport);
    wallet = Wallet(store: keyStore, authenticator: authenticator);
    tx = TxSigner(api: api, wallet: wallet);
    witnessKeys = WitnessKeys(keyStore);
    transport.onUnauthorized = () {
      if (_token != null) unawaited(signOut());
    };
  }

  static const String tokenKey = 'verdict.session.token.v1';

  final AppConfig config;
  final KeyStore store;
  final ApiTransport transport;
  final ChannelFactory? _wsConnect;
  final FaceCapture Function() newFaceCapture;
  final VoiceCapture Function() newVoiceCapture;
  final SceneCamera Function() newSceneCamera;
  final PoseSource Function() newPoseSource;
  final WitnessRunner Function(String betId)? _witnessRunner;
  final StartSignal Function()? _startSignal;
  final AudioOut? _audioOut;

  /// Opens a URL in an external browser (Receipt links).
  final LinkOpener openLink;

  /// This phone's witnesses for [betId].
  WitnessRunner newWitnessRunner(String betId) =>
      _witnessRunner?.call(betId) ?? WitnessSession(api: api, ws: _ws, keys: witnessKeys, betId: betId);

  /// Start sound + beacon tones.
  StartSignal newStartSignal() => _startSignal?.call() ?? BeaconPlayer(transport: transport);

  /// Spoken output (questions, read-back, announcer).
  late final AudioOut audio = _audioOut ?? PlayerAudioOut(transport);

  late final ApiClient api;
  late final Wallet wallet;
  late final TxSigner tx;
  late final WitnessKeys witnessKeys;

  String? _token;
  UserView? _user;
  int? _balance;
  List<BetView> _bets = const [];
  WsClient? _ws;
  StreamSubscription<WsMessage>? _wsSub;
  bool _ready = false;
  final _notices = StreamController<WsNotify>.broadcast();
  final _wsRelay = StreamController<WsMessage>.broadcast();
  final Map<String, int> _topicRefs = {};

  bool get ready => _ready;
  bool get signedIn => _token != null && _user != null;
  UserView? get user => _user;
  int? get balanceUnits => _balance;
  List<BetView> get bets => _bets;
  WsClient? get ws => _ws;

  /// WS `notify` messages (shown as a transient banner).
  Stream<WsNotify> get notices => _notices.stream;

  /// Every server → client WS message, after the controller has applied it.
  Stream<WsMessage> get wsMessages => _wsRelay.stream;

  /// Signed-in user's id.
  String? get userId => _user?.id;

  /// Subscribes to [topics] for as long as the returned lease is held.
  /// Topics are reference-counted, so stacked screens can share them.
  TopicLease watch(Iterable<String> topics) {
    final fresh = <String>[];
    final list = topics.toList();
    for (final t in list) {
      final n = _topicRefs[t] ?? 0;
      _topicRefs[t] = n + 1;
      if (n == 0) fresh.add(t);
    }
    if (fresh.isNotEmpty) _ws?.subscribe(fresh);
    return TopicLease._(this, list);
  }

  void _release(List<String> topics) {
    final gone = <String>[];
    for (final t in topics) {
      final n = (_topicRefs[t] ?? 0) - 1;
      if (n <= 0) {
        _topicRefs.remove(t);
        gone.add(t);
      } else {
        _topicRefs[t] = n;
      }
    }
    if (gone.isNotEmpty) _ws?.unsubscribe(gone);
  }

  /// Feeds a message through the WS pipeline (tests, local echoes).
  @visibleForTesting
  void injectWs(WsMessage m) => _onWs(m);

  /// Restores a stored session, if any.
  Future<void> bootstrap() async {
    try {
      final t = await store.read(tokenKey);
      if (t != null) {
        _token = t;
        transport.token = t;
        try {
          _user = await api.me();
          _connectWs();
        } on ApiException catch (e) {
          if (e.code == 'UNAUTHORIZED') await _clearSession();
          // Offline: keep the token; screens retry.
        }
      }
    } finally {
      _ready = true;
      notifyListeners();
    }
  }

  /// `GET /auth/nonce` → wallet signature → `POST /auth/session` (§12.3).
  Future<UserView> signIn({required String provider, required String credential, String? emailCode}) async {
    final nonce = await api.authNonce();
    final address = await wallet.address();
    final sig = await wallet.signLogin(nonce);
    final s = await api.createSession(
      provider: provider,
      credential: credential,
      emailCode: emailCode,
      wallet: address,
      nonce: nonce,
      walletSig: sig,
    );
    _token = s.token;
    transport.token = s.token;
    _user = s.user;
    await store.write(tokenKey, s.token);
    _connectWs();
    notifyListeners();
    return s.user;
  }

  Future<void> signOut() async {
    await _clearSession();
    notifyListeners();
  }

  Future<void> _clearSession() async {
    _token = null;
    transport.token = null;
    _user = null;
    _balance = null;
    _bets = const [];
    wallet.lock();
    await _wsSub?.cancel();
    _wsSub = null;
    await _ws?.close();
    _ws = null;
    await store.delete(tokenKey);
  }

  Future<UserView> refreshUser() async {
    final u = await api.me();
    _user = u;
    notifyListeners();
    return u;
  }

  Future<void> refreshHome() async {
    final results = await Future.wait([api.balance(), api.bets()]);
    _balance = results[0] as int;
    _bets = _sorted(results[1] as List<BetView>);
    notifyListeners();
  }

  /// Demo drip (`POST /faucet`).
  Future<void> faucet() async {
    _balance = await api.faucet();
    notifyListeners();
  }

  void _connectWs() {
    final t = _token;
    if (t == null || _ws != null) return;
    final ws = WsClient(baseUrl: config.apiBaseUrl, token: t, connect: _wsConnect);
    _ws = ws;
    _wsSub = ws.messages.listen(_onWs);
    ws.subscribe([Topics.user, ..._topicRefs.keys]);
    ws.open();
  }

  void _onWs(WsMessage m) {
    switch (m) {
      case WsBet(:final bet):
        upsertBet(bet);
      case WsNotify():
        _notices.add(m);
      case WsChain(:final name) when name == 'Settled' || name == 'Refunded' || name == 'Funded':
        unawaited(api.balance().then((b) {
          _balance = b;
          notifyListeners();
        }).catchError((Object _) {}));
      default:
        break;
    }
    if (!_wsRelay.isClosed) _wsRelay.add(m);
  }

  /// Inserts or replaces a bet (snapshots are truth; newest `updated_at_ms`
  /// wins).
  void upsertBet(BetView bet) {
    final list = List<BetView>.of(_bets);
    final i = list.indexWhere((b) => b.id == bet.id);
    if (i >= 0) {
      if (list[i].updatedAtMs > bet.updatedAtMs) return;
      list[i] = bet;
    } else {
      list.add(bet);
    }
    _bets = _sorted(list);
    notifyListeners();
  }

  static List<BetView> _sorted(List<BetView> l) =>
      List<BetView>.of(l)..sort((a, b) => b.updatedAtMs.compareTo(a.updatedAtMs));

  @override
  void dispose() {
    unawaited(_wsSub?.cancel());
    unawaited(_ws?.close());
    unawaited(_notices.close());
    unawaited(_wsRelay.close());
    final a = _audioOut;
    if (a != null) unawaited(a.dispose());
    transport.close();
    super.dispose();
  }
}

/// A held WS subscription (see [AppController.watch]).
class TopicLease {
  TopicLease._(this._app, this.topics);
  final AppController _app;
  final List<String> topics;
  bool _released = false;

  void release() {
    if (_released) return;
    _released = true;
    _app._release(topics);
  }
}
