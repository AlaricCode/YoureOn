import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState, WidgetsBinding, WidgetsBindingObserver;
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
import '../platform/local_notices.dart';
import '../platform/screen_awake.dart';
import '../wallet/key_store.dart';
import '../wallet/tx_signer.dart';
import '../wallet/wallet.dart';
import '../wallet/witness_keys.dart';
import '../ws/ws_client.dart';
import '../ws/ws_messages.dart';
import 'config.dart';

/// App-wide services and session state.
class AppController extends ChangeNotifier with WidgetsBindingObserver {
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
    LocalNotices? localNotices,
    ScreenAwake? screenAwake,
  })  : store = keyStore,
        localNotices = localNotices ?? PluginLocalNotices(),
        screenAwake = screenAwake ?? WakelockScreenAwake(),
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

  /// On-device notifications ([D-29]).
  final LocalNotices localNotices;

  /// Screen-on holds for capture screens.
  final ScreenAwake screenAwake;

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

  AppLifecycleState _lifecycle = AppLifecycleState.resumed;
  bool _observing = false;
  Timer? _restoreTimer;
  int _restoreAttempt = 0;
  bool _restoring = false;
  Map<String, BetState>? _statesAtPause;

  /// Bets whose witnesses this app session has started (Record never
  /// restarts a sealed chain).
  final Set<String> witnessedBets = {};

  /// Bet ids with a scheduled consent reminder (local notification).
  final Set<String> _reminders = {};

  /// Lead time of the consent reminder before silence counts as consent.
  static const Duration consentReminderLead = Duration(minutes: 2);

  bool get ready => _ready;
  bool get signedIn => _token != null && _user != null;

  /// A stored token whose session could not be checked yet (offline at
  /// launch). RootGate shows a reconnecting screen, not Sign in.
  bool get restoring => _restoring && _token != null && _user == null;

  /// Whether the app is in the foreground.
  bool get foreground => _lifecycle == AppLifecycleState.resumed;
  UserView? get user => _user;
  int? get balanceUnits => _balance;
  List<BetView> get bets => _bets;
  WsClient? get ws => _ws;

  /// WS `notify` messages received in the foreground, plus bet changes
  /// found on resume (shown as a transient banner). In the background the
  /// titles go to [localNotices] instead.
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
    _observeLifecycle();
    unawaited(localNotices.init());
    try {
      final t = await store.read(tokenKey);
      if (t != null) {
        _token = t;
        transport.token = t;
        await _tryRestore();
      }
    } catch (e) {
      // Never let a storage/plugin error escape main().
      debugPrint('bootstrap: $e');
    } finally {
      _ready = true;
      notifyListeners();
    }
  }

  /// One `GET /me` attempt for the stored token. UNAUTHORIZED clears the
  /// session; any other failure keeps the token and schedules a retry with
  /// capped exponential backoff (1 s, 2 s, 4 s … 30 s).
  Future<void> _tryRestore() async {
    _restoreTimer?.cancel();
    _restoreTimer = null;
    if (_token == null) return;
    try {
      _user = await api.me();
      _restoring = false;
      _restoreAttempt = 0;
      _connectWs();
    } on ApiException catch (e) {
      if (e.code == 'UNAUTHORIZED') {
        _restoring = false;
        await _clearSession();
        return;
      }
      _scheduleRestore();
    } catch (_) {
      _scheduleRestore();
    }
  }

  void _scheduleRestore() {
    if (_token == null) return;
    _restoring = true;
    final secs = 1 << _restoreAttempt.clamp(0, 5);
    _restoreAttempt++;
    _restoreTimer?.cancel();
    _restoreTimer = Timer(Duration(seconds: secs > 30 ? 30 : secs), () => unawaited(retryRestore()));
  }

  /// Retries restoring the stored session now (RootGate's Retry).
  Future<void> retryRestore() async {
    if (_token == null || _user != null) return;
    await _tryRestore();
    notifyListeners();
  }

  void _observeLifecycle() {
    if (_observing) return;
    _observing = true;
    final b = WidgetsBinding.instance;
    // Before the first lifecycle event the state is unknown (null/detached):
    // bootstrap runs with the UI starting, so assume the foreground.
    final st = b.lifecycleState;
    _lifecycle = st == null || st == AppLifecycleState.detached ? AppLifecycleState.resumed : st;
    b.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final wasForeground = foreground;
    _lifecycle = state;
    if (wasForeground && !foreground) {
      _statesAtPause = {for (final b in _bets) b.id: b.state};
    } else if (!wasForeground && foreground) {
      unawaited(_onResumed());
    }
  }

  /// Back in the foreground: the socket may have been suspended, so
  /// re-fetch bet state and surface what changed as in-app notices.
  Future<void> _onResumed() async {
    final before = _statesAtPause;
    _statesAtPause = null;
    if (!signedIn) {
      if (_token != null) await retryRestore();
      return;
    }
    try {
      await refreshHome();
    } catch (_) {
      return;
    }
    if (before == null) return;
    for (final b in _bets) {
      final was = before[b.id];
      if (was == b.state) continue;
      final title = was == null && b.state == BetState.proposed ? 'Bet offered' : b.stateLabel;
      if (!_notices.isClosed) _notices.add(WsNotify(title, b.id));
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
    _restoreTimer?.cancel();
    _restoreTimer = null;
    _restoring = false;
    _restoreAttempt = 0;
    for (final id in _reminders) {
      unawaited(localNotices.cancel(_reminderId(id)));
    }
    _reminders.clear();
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
    _bets.forEach(_syncReminder);
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
      case WsNotify(:final title, :final betId):
        if (foreground) {
          if (!_notices.isClosed) _notices.add(m);
        } else {
          unawaited(localNotices.show(title));
        }
        // Home lists the named bet without a pull-to-refresh.
        if (betId != null) unawaited(_fetchBet(betId));
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
    _syncReminder(bet);
    notifyListeners();
  }

  Future<void> _fetchBet(String id) async {
    try {
      upsertBet(await api.bet(id));
    } catch (_) {
      // Not visible yet (or offline): the next snapshot or refresh has it.
    }
  }

  static int _reminderId(String betId) => 10000 + (betId.hashCode & 0x3fffffff) % 1000000000;

  /// Schedules a local notification ahead of the consent deadline while
  /// this user's consent on a pre-ruling is pending ([D-29]); a suspended
  /// socket can't deliver it in time.
  void _syncReminder(BetView bet) {
    final me = bet.me;
    final deadline = bet.preruling?.consentDeadlineMs ?? bet.deadlines.consent;
    final pending = bet.state == BetState.preruled && me != null && me.consent == Consent.pending && deadline != null;
    if (pending) {
      if (!_reminders.add(bet.id)) return;
      var at = DateTime.fromMillisecondsSinceEpoch(deadline).subtract(consentReminderLead);
      final now = DateTime.now();
      if (at.isBefore(now)) at = now.add(const Duration(seconds: 5));
      unawaited(localNotices.schedule(_reminderId(bet.id), 'Consent due', at));
    } else if (_reminders.remove(bet.id)) {
      unawaited(localNotices.cancel(_reminderId(bet.id)));
    }
  }

  static List<BetView> _sorted(List<BetView> l) =>
      List<BetView>.of(l)..sort((a, b) => b.updatedAtMs.compareTo(a.updatedAtMs));

  @override
  void dispose() {
    _restoreTimer?.cancel();
    if (_observing) WidgetsBinding.instance.removeObserver(this);
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
