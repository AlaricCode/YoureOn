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
class RecordScreen extends StatefulWidget {
  const RecordScreen({super.key, required this.args});
  final BetArgs args;

  @override
  State<RecordScreen> createState() => _RecordScreenState();
}

class _RecordScreenState extends State<RecordScreen> with Guarded, WsWatch {
  BetView? _bet;
  SceneCamera? _cam;
  PoseSource? _pose;
  StreamSubscription<CameraPose>? _poseSub;
  WitnessRunner? _runner;
  StartSignal? _signal;
  Future<void>? _registering;
  DateTime? _t0;
  Timer? _tick;
  bool _ending = false;
  bool _leaving = false;
  bool _cameraLocked = false;

  String get _betId => widget.args.betId;
  bool get _isCamera => _bet != null && _bet!.creatorUserId == app.userId;

  @override
  void initState() {
    super.initState();
    _bet = widget.args.bet;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      watchWs([Topics.bet(_betId)], _onWs);
      _load();
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    _poseSub?.cancel();
    _pose?.stop();
    final runner = _runner;
    // Leaving mid-recording still seals and uploads what was recorded.
    if (runner != null && runner.recording && !_ending) unawaited(runner.end());
    unawaited(_signal?.dispose());
    unawaited(_cam?.close());
    if (_cameraLocked) SystemChrome.setPreferredOrientations(const []);
    super.dispose();
  }

  Future<void> _load() => guard('load', () async {
        final bet = await app.api.bet(_betId);
        _setBet(bet);
        if (bet.state == BetState.funded) {
          if (_isCamera) await _openCamera();
          await _register();
        } else if (bet.state == BetState.live && bet.t0Ms != null && _t0 == null) {
          _startClock(DateTime.fromMillisecondsSinceEpoch(bet.t0Ms!));
        }
      });

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
      throw ApiException('NO_CAMERA');
    }
    final pose = _pose = app.newPoseSource()..start();
    _poseSub = pose.poses.listen((_) {
      if (mounted) setState(() {});
    });
    if (mounted) setState(() {});
  }

  Future<void> _register() {
    return _registering ??= () async {
      final runner = _runner ??= app.newWitnessRunner(_betId);
      try {
        await runner.register(camera: _isCamera && _cam != null);
      } on ApiException catch (e) {
        if (e.code != 'WRONG_STATE') rethrow; // already registered
      }
    }();
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
  /// start signal; t0 comes from the local playback schedule.
  Future<void> _onStart(WsStart start) async {
    final received = DateTime.now();
    final runner = _runner ??= app.newWitnessRunner(_betId);
    await guard('start-recording', () async {
      await _registering;
      final cam = _cam;
      await runner.begin(start, controller: cam?.controller, cameraMeta: cam?.meta);
      if (mounted) setState(() {});
    }, exclusive: false);
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
        await _runner?.end();
        _finish();
      });

  /// The time limit passed: the keeper ends the bet; this phone just stops
  /// after the tail.
  Future<void> _stopLocal() async {
    _ending = true;
    _tick?.cancel();
    await guard('end', () async {
      await _runner?.end();
    }, exclusive: false);
    if (mounted) setState(() {});
  }

  void _finish() {
    if (_leaving) return;
    _leaving = true;
    Future<void> go() async {
      final runner = _runner;
      if (runner != null && runner.recording && !_ending) {
        _ending = true;
        await runner.end();
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

