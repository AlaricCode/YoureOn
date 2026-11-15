import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../api/api_error.dart';
import '../../api/models/bet.dart';
import '../../api/models/calibration.dart';
import '../../beacon/beacon_player.dart';
import '../../capture/pose.dart';
import '../../capture/scene_camera.dart';
import '../../core/format.dart';
import '../../evidence/witness_runner.dart';
import '../../nav/routes.dart';
import '../../platform/screen_awake.dart';
import '../../state/guarded.dart';
import '../../state/ws_watch.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/page.dart';
import '../../ui/widgets/sheet.dart';
import '../../ui/widgets/text.dart';
import '../../ws/ws_messages.dart';

/// Record (spec §3.6/§6.5, CONTRACTS.md §7.5, §12.10): viewfinder · timer
/// (t0 → limit) · witness count · End.
///
/// The creator's phone is the camera: it registers a `camera` and an
/// `audio` witness; every other phone registers `audio`. On WS `start`
/// every witness starts recording and the camera phone plays the start
/// sound and beacon tones. After End (or the limit) recording continues
/// `TAIL_MS`, then the final chunks are sealed and uploaded.
///
/// `start` is replayed in the `bet:<id>` snapshot while Live, so a phone
/// that opens Record (or reconnects) after the start still begins its
/// already-registered witnesses, without playing the start signal; such a
/// phone never hears the beacon, so its footage stays unsynced unless
/// another witness on the same device heard it. A phone whose registration
/// did not complete before the start shows "Not a witness".
class RecordScreen extends StatefulWidget {
  const RecordScreen({super.key, required this.args});
  final BetArgs args;

  @override
  State<RecordScreen> createState() => _RecordScreenState();
}

class _RecordScreenState extends State<RecordScreen> with Guarded, WsWatch, WidgetsBindingObserver {
  BetView? _bet;
  SceneCamera? _cam;
  PoseSource? _pose;
  StreamSubscription<CameraPose>? _poseSub;
  WitnessRunner? _runner;
  StartSignal? _signal;
  Future<void>? _registering;
  bool _registered = false;
  bool _notWitness = false;
  bool _loaded = false;
  bool _joinedLate = false;
  bool _startSeen = false;
  WsStart? _pendingStart;
  Future<void>? _endFuture;
  bool _reopenCamera = false;
  ScreenAwake? _awake;
  DateTime? _t0;
  Timer? _tick;
  bool _ending = false;
  bool _leaving = false;
  bool _cameraLocked = false;

  /// A `start` received this long after the bet's t0 is a replay.
  static const int _lateSlackMs = 2000;

  String get _betId => widget.args.betId;
  bool get _isCamera => _bet != null && _bet!.creatorUserId == app.userId;

  @override
  void initState() {
    super.initState();
    _bet = widget.args.bet;
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // Witness phones lie on the table: keep the screen (camera, mic) on.
      _awake = app.screenAwake..hold();
      watchWs([Topics.bet(_betId)], _onWs);
      _load();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _awake?.release();
    _tick?.cancel();
    _poseSub?.cancel();
    _pose?.stop();
    unawaited(_signal?.dispose());
    // Leaving mid-recording still seals and uploads what was recorded: the
    // camera stays open until the witnesses have finalized (the final MP4
    // segment is cut from the controller), then closes.
    final cam = _cam;
    _cam = null;
    unawaited(_endRunner().catchError((Object e) {
      debugPrint('witness end on dispose: $e');
    }).whenComplete(() async {
      try {
        await cam?.close();
      } catch (_) {}
    }));
    if (_cameraLocked) SystemChrome.setPreferredOrientations(const []);
    super.dispose();
  }

  /// Ends this phone's witnesses once; every caller shares the same future.
  Future<void> _endRunner() {
    final pending = _endFuture;
    if (pending != null) return pending;
    final runner = _runner;
    if (runner == null || !runner.recording) return Future<void>.value();
    return _endFuture = runner.end();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!mounted) return;
    final recording = _runner?.recording ?? false;
    switch (state) {
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        if (recording && !_ending) {
          // The OS takes the camera and silences the mic in the background:
          // finalize cleanly instead of leaving a broken chain.
          unawaited(_stopLocal());
        } else if (!recording) {
          _releaseCamera();
        }
      case AppLifecycleState.inactive:
        break; // transient (permission dialog, shade)
      case AppLifecycleState.resumed:
        if (_reopenCamera && !recording && _bet?.state == BetState.funded) {
          _reopenCamera = false;
          guard('camera', _openCamera, exclusive: false);
        }
    }
  }

  void _releaseCamera() {
    final cam = _cam;
    if (cam == null || _endFuture != null) return;
    _reopenCamera = true;
    _poseSub?.cancel();
    _poseSub = null;
    _pose?.stop();
    _pose = null;
    _cam = null;
    setState(() {});
    unawaited(cam.close().catchError((Object _) {}));
  }

  Future<void> _load() async {
    await guard('load', () async {
      final bet = await app.api.bet(_betId);
      _setBet(bet);
      if (bet.state == BetState.funded) {
        // A camera failure still registers the audio witness, then shows.
        ApiException? camError;
        if (_isCamera) {
          try {
            await _openCamera();
          } on ApiException catch (e) {
            camError = e;
          }
        }
        await _register();
        if (camError != null) throw camError;
      } else if (bet.state == BetState.live) {
        if (bet.t0Ms != null && _t0 == null) _startClock(DateTime.fromMillisecondsSinceEpoch(bet.t0Ms!));
        await _rejoin(bet);
      }
    });
    _loaded = true;
    final pending = _pendingStart;
    _pendingStart = null;
    if (pending != null && mounted) await _onStart(pending);
  }

  /// Opened (or reopened) after the start: resume only witnesses this
  /// user registered before the list froze (re-registering the same key is
  /// idempotent; a new key is refused).
  Future<void> _rejoin(BetView bet) async {
    final me = app.userId;
    final mine = bet.witnesses.where((w) => w.userId != null && w.userId == me).toList();
    if (mine.isEmpty) {
      if (mounted) setState(() => _notWitness = true);
      return;
    }
    _joinedLate = true;
    var camera = _isCamera && mine.any((w) => w.kind == 'camera');
    if (camera) {
      try {
        await _openCamera();
      } on ApiException {
        camera = false;
      }
    }
    await _register(camera: camera && _cam != null);
  }

  void _setBet(BetView bet) {
    if (!mounted) return;
    final cur = _bet;
    if (cur != null && cur.updatedAtMs > bet.updatedAtMs) return;
    setState(() => _bet = bet);
    app.upsertBet(bet);
    final s = bet.state;
    if (s != BetState.proposed && s != BetState.funded && s != BetState.live) _finish();
  }

  Future<void> _openCamera() async {
    _cameraLocked = true;
    unawaited(SystemChrome.setPreferredOrientations(const [DeviceOrientation.portraitUp]));
    final cam = _cam ??= app.newSceneCamera();
    try {
      await cam.open();
    } catch (_) {
      // The previous screen's camera may still be closing: retry once.
      await Future<void>.delayed(const Duration(milliseconds: 400));
      try {
        await cam.open();
      } catch (_) {
        throw ApiException('NO_CAMERA');
      }
    }
    final pose = _pose = app.newPoseSource()..start();
    _poseSub = pose.poses.listen((_) {
      if (mounted) setState(() {});
    });
    if (mounted) setState(() {});
  }

  /// Registers this phone's witnesses. Only a successful reply counts:
  /// re-registering the same key is idempotent (200), while `WRONG_STATE`
  /// ("witness list fixed at start", one witness per kind) or a full list
  /// means this phone is not a witness.
  Future<void> _register({bool? camera}) {
    return _registering ??= () async {
      final runner = _runner ??= app.newWitnessRunner(_betId);
      try {
        await runner.register(camera: camera ?? (_isCamera && _cam != null));
        _registered = true;
      } on ApiException {
        if (mounted) setState(() => _notWitness = true);
        rethrow;
      }
    }();
  }

  /// Whether registration completed (waits for one in flight).
  Future<bool> _awaitRegistration() async {
    final r = _registering;
    if (r == null) return false;
    try {
      await r;
    } catch (_) {}
    return _registered;
  }

  void _onWs(WsMessage m) {
    switch (m) {
      case WsBet(:final bet) when bet.id == _betId:
        _setBet(bet);
      case WsStart() when m.betId == _betId:
        _onStart(m);
      default:
        break;
    }
  }

  /// WS `start`: every witness starts recording; the camera phone plays the
  /// start signal; t0 comes from the local playback schedule. Idempotent: a
  /// replayed `start` (snapshot after a reconnect or a late open) begins
  /// registered witnesses without playing the signal again.
  Future<void> _onStart(WsStart start) async {
    if (_startSeen || _ending) return;
    if (!_loaded) {
      _pendingStart = start; // _load decides once registration state is known
      return;
    }
    _startSeen = true;
    final received = DateTime.now();
    final runner = _runner ??= app.newWitnessRunner(_betId);
    // This app already recorded this bet (an earlier Record screen): its
    // chains are sealed; never restart them from index 0.
    if (runner.recording || app.witnessedBets.contains(_betId)) return;
    final t0Ms = _bet?.t0Ms;
    // A replay: opened after the start, or (reconnect) the bet is already
    // Live with its t0 well in the past. A fresh start's t0 is still ahead.
    final late = _joinedLate ||
        (_bet?.state == BetState.live && t0Ms != null && received.millisecondsSinceEpoch > t0Ms + _lateSlackMs);
    if (await _awaitRegistration()) {
      await guard('start-recording', () async {
        final cam = _cam;
        await runner.begin(start, controller: cam?.controller, cameraMeta: cam?.meta);
        app.witnessedBets.add(_betId);
        if (mounted) setState(() {});
      }, exclusive: false);
    } else if (mounted) {
      setState(() => _notWitness = true);
    }
    if (late) {
      if (t0Ms != null && _t0 == null) _startClock(DateTime.fromMillisecondsSinceEpoch(t0Ms));
      return;
    }
    final signal = _signal ??= app.newStartSignal();
    try {
      final t0 = await signal.run(start, myUserId: app.userId ?? '', receivedAt: received);
      _startClock(t0);
    } catch (_) {
      _startClock(received.add(const Duration(milliseconds: 1500 + 2100)));
    }
  }

  void _startClock(DateTime t0) {
    if (!mounted) return;
    setState(() => _t0 = t0);
    _tick?.cancel();
    _tick = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (!mounted) return;
      setState(() {});
      final limit = _limitMs;
      if (limit != null && _elapsedMs >= limit && !_ending) _stopLocal();
    });
  }

  int get _elapsedMs {
    final t0 = _t0;
    if (t0 == null) return 0;
    final ms = DateTime.now().difference(t0).inMilliseconds;
    return ms < 0 ? 0 : ms;
  }

  int? get _limitMs {
    final b = _bet;
    return b == null ? null : b.timeLimitS * 1000;
  }

  Future<void> _start() => guard('start', () async {
        await _registering;
        await app.api.start(_betId);
      });

  /// End tapped: `POST /end`, keep recording `TAIL_MS`, then seal and drain.
  Future<void> _end() => guard('end', () async {
        _ending = true;
        _tick?.cancel();
        try {
          await app.api.end(_betId);
        } on ApiException catch (e) {
          if (e.code != 'WRONG_STATE') rethrow; // already ended elsewhere
        }
        await _endRunner();
        _finish();
      });

  /// The time limit passed: the keeper ends the bet; this phone just stops
  /// after the tail.
  Future<void> _stopLocal() async {
    _ending = true;
    _tick?.cancel();
    await guard('end', _endRunner, exclusive: false);
    if (mounted) setState(() {});
  }

  void _finish() {
    if (_leaving) return;
    _leaving = true;
    Future<void> go() async {
      final runner = _runner;
      if (runner != null && runner.recording) {
        _ending = true;
        try {
          await _endRunner();
        } catch (_) {}
      }
      if (!mounted) return;
      final bet = _bet;
      Navigator.of(context).pushReplacementNamed(Routes.ruling, arguments: BetArgs(_betId, bet: bet));
    }

    WidgetsBinding.instance.addPostFrameCallback((_) => go());
  }

  // ---- UI --------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final bet = _bet;
    final live = bet?.state == BetState.live || (_runner?.recording ?? false);
    final calibrated = bet?.calibration?.camera.pose;
    final moved = _isCamera && cameraMoved(calibrated, _pose?.current);
    final uploadError = _runner?.uploadError;
    return AppPage(
      title: 'Record',
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ErrorLine(error ?? (uploadError == null ? null : ApiException(uploadError).message)),
          _action(bet, live),
        ],
      ),
      child: ListView(
        children: [
          const SizedBox(height: Space.x1),
          _viewfinder(live, moved),
          const SizedBox(height: Space.x3),
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              if (live) ...[
                const StatusDot(on: true, live: true),
                const SizedBox(width: Space.x2),
              ],
              DataText(formatClock(_elapsedMs), key: const ValueKey('timer'), style: Typo.display),
              const SizedBox(width: Space.x1),
              if (bet != null) DataText('/ ${formatClock(bet.timeLimitS * 1000)}', style: Typo.value),
            ],
          ),
          const SizedBox(height: Space.x2),
          const Hairline(),
          KeyValueRow(label: 'Witnesses', value: '${bet?.witnesses.length ?? 0}'),
          const Hairline(),
          if (_notWitness && !(_runner?.recording ?? false)) ...[
            const ListRow(key: ValueKey('not-witness'), label: 'Not a witness'),
            const Hairline(),
          ],
        ],
      ),
    );
  }

  Widget _action(BetView? bet, bool live) {
    if (bet == null) return const QuietButton(label: 'Waiting', onPressed: null);
    if (bet.state == BetState.funded && !(_runner?.recording ?? false)) {
      if (_isCamera) {
        return PrimaryButton(label: 'Start', busy: busyWith('start'), onPressed: busy ? null : _start);
      }
      return const QuietButton(label: 'Waiting', onPressed: null);
    }
    if (live && bet.isParticipant) {
      return PrimaryButton(label: 'End', busy: busyWith('end'), onPressed: _ending ? null : _end);
    }
    return const QuietButton(label: 'Waiting', onPressed: null);
  }

  Widget _viewfinder(bool live, bool moved) {
    final cam = _cam;
    return AspectRatio(
      aspectRatio: 3 / 4,
      child: ClipRRect(
        borderRadius: const BorderRadius.all(Radius.circular(12)),
        child: ColoredBox(
          color: Palette.surface,
          child: Stack(fit: StackFit.expand, children: [
            if (cam != null && cam.isOpen)
              cam.preview()
            else
              const Center(child: Icon(LucideIcons.mic, size: 32, color: Palette.secondary)),
            if (moved)
              const Positioned(
                top: Space.x2,
                left: 0,
                right: 0,
                child: Center(child: Label('Camera moved', style: Typo.labelStrong)),
              ),
          ]),
        ),
      ),
    );
  }
}

