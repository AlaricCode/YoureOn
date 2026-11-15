import 'dart:async';
import 'dart:typed_data';

import 'package:camera/camera.dart' show CameraController;
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/models/calibration.dart';
import 'package:verdict/api/api_error.dart';
import 'package:verdict/app.dart';
import 'package:verdict/beacon/beacon_player.dart';
import 'package:verdict/capture/face_capture.dart';
import 'package:verdict/capture/pose.dart';
import 'package:verdict/capture/scene_camera.dart';
import 'package:verdict/capture/voice_capture.dart';
import 'package:verdict/evidence/chunk_uploader.dart';
import 'package:verdict/evidence/wav.dart';
import 'package:verdict/evidence/witness_runner.dart';
import 'package:verdict/media/audio_out.dart';
import 'package:verdict/platform/local_notices.dart';
import 'package:verdict/platform/screen_awake.dart';
import 'package:verdict/state/app_controller.dart';
import 'package:verdict/state/config.dart';
import 'package:verdict/wallet/key_store.dart';
import 'package:verdict/wallet/wallet.dart';
import 'package:verdict/ws/ws_messages.dart';

import 'fake_channel.dart';
import 'fake_server.dart';
import 'golden.dart';

class FakeFaceCapture implements FaceCapture {
  bool _open = false;
  int captures = 0;

  /// Faces returned by the next captures (default: one turned face).
  List<DetectedFace> faces = const [DetectedFace(bbox: [3000, 2000, 7000, 7000], yawDeg: 20, pitchDeg: 20)];

  @override
  bool get isOpen => _open;

  @override
  Future<void> open({bool front = true}) async => _open = true;

  @override
  Widget preview() => const SizedBox.expand();

  @override
  Future<CapturedFrame> capture() async {
    captures++;
    return CapturedFrame(jpeg: Uint8List.fromList([0xff, 0xd8, captures, 0xff, 0xd9]), width: 480, height: 640, faces: faces);
  }

  @override
  Future<void> close() async => _open = false;
}

class FakeVoiceCapture implements VoiceCapture {
  bool _rec = false;

  @override
  bool get recording => _rec;

  @override
  Future<bool> hasPermission() async => true;

  @override
  Future<void> start() async => _rec = true;

  @override
  Future<Uint8List> stop() async {
    _rec = false;
    return encodeWavPcm16(Int16List(1600), sampleRate: 16000);
  }

  @override
  Future<void> dispose() async {}
}

/// Rear camera fake: frames are pushed by the test with [emit].
class FakeSceneCamera implements SceneCamera {
  bool _open = false;
  StreamController<SceneFrame>? _frames;
  int stills = 0;

  /// 'open' / 'close' in call order (camera handoffs between screens).
  final List<String> log = [];

  /// Opening while already open (two screens holding the camera) throws.
  bool strict = false;

  @override
  CameraMeta? meta;

  @override
  bool get isOpen => _open;

  @override
  CameraController? get controller => null;

  @override
  Future<void> open() async {
    if (strict && _open) throw StateError('camera in use');
    log.add('open');
    _open = true;
    meta = const CameraMeta(widthPx: 720, heightPx: 1280, orientation: 'portrait');
  }

  @override
  Widget preview() => const SizedBox.expand();

  @override
  Stream<SceneFrame> frames({int fps = 10}) {
    final c = _frames = StreamController<SceneFrame>();
    return c.stream;
  }

  void emit(int tMs) => _frames?.add(SceneFrame(Uint8List.fromList([0xff, 0xd8, tMs & 0xff, 0xff, 0xd9]), tMs));

  @override
  Future<Uint8List> still() async {
    stills++;
    return Uint8List.fromList([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  }

  @override
  Future<void> close() async {
    if (_open) log.add('close');
    _open = false;
    // Not awaited: a cancelled controller's done future completes in the
    // root zone, outside the widget test's fake async.
    unawaited(_frames?.close());
  }
}

class FakeWitnessRunner implements WitnessRunner {
  FakeWitnessRunner(this.betId);
  final String betId;
  final List<bool> registered = [];
  final List<WsStart> begins = [];
  WsStart? started;
  bool ended = false;
  bool _recording = false;

  /// When set, `register` fails with this code.
  String? registerError;

  /// When set, `end` waits for it (a witness still finalizing).
  Completer<void>? endGate;

  /// Whether the scene camera was still open when `end` completed.
  bool? cameraOpenAtEnd;
  FakeSceneCamera? camera;

  @override
  Future<List<String>> register({required bool camera}) async {
    registered.add(camera);
    final e = registerError;
    if (e != null) throw ApiException(e);
    return [if (camera) 'Camera 1', 'Mic 1'];
  }

  @override
  Future<void> begin(WsStart start, {CameraController? controller, CameraMeta? cameraMeta}) async {
    begins.add(start);
    started = start;
    _recording = true;
  }

  @override
  Future<void> end() async {
    final gate = endGate;
    if (gate != null) await gate.future;
    cameraOpenAtEnd = camera?.isOpen;
    ended = true;
    _recording = false;
  }

  @override
  bool get recording => _recording;

  @override
  int get sealedChunks => 0;

  @override
  String? get uploadError => null;
}

class FakeStartSignal implements StartSignal {
  final List<String> runs = [];

  @override
  Future<DateTime> run(WsStart start, {required String myUserId, DateTime? receivedAt}) async {
    runs.add(myUserId);
    return receivedAt ?? DateTime.now();
  }

  @override
  Future<void> dispose() async {}
}

/// Records local notifications instead of posting them.
class FakeLocalNotices implements LocalNotices {
  final List<String> shown = [];
  final Map<int, (String, DateTime)> scheduled = {};
  final List<int> cancelled = [];

  @override
  Future<void> init() async {}

  @override
  Future<void> show(String title) async => shown.add(title);

  @override
  Future<void> schedule(int id, String title, DateTime at) async => scheduled[id] = (title, at);

  @override
  Future<void> cancel(int id) async {
    cancelled.add(id);
    scheduled.remove(id);
  }
}

/// Device fakes shared by a test.
class Devices {
  final scene = FakeSceneCamera();
  final notices = FakeLocalNotices();
  final awake = CountingScreenAwake();

  /// Applied to every new [FakeWitnessRunner].
  String? registerError;
  Completer<void>? endGate;
  final pose = FixedPoseSource(const CameraPose(pitchCdeg: 0, rollCdeg: 0));
  final runners = <String, FakeWitnessRunner>{};
  final signal = FakeStartSignal();
  final audio = SilentAudioOut();
  final links = <Uri>[];
}

/// Builds an [AppController] wired to [server], with the golden wallet seed,
/// an always-yes passkey prompt and a WebSocket that never connects.
AppController testController(
  FakeServer server, {
  String? token,
  FakeFaceCapture? face,
  FakeVoiceCapture? voice,
  Devices? devices,
  void Function(Uri uri)? onSocket,
}) {
  final d = devices ?? Devices();
  final store = MemoryKeyStore()..data[Wallet.seedKey] = toHexSeed();
  if (token != null) store.data[AppController.tokenKey] = token;
  return AppController(
    config: const AppConfig(apiBaseUrl: 'http://api.test'),
    keyStore: store,
    authenticator: AllowAuthenticator(),
    httpClient: server.client,
    wsConnect: (u) {
      onSocket?.call(u);
      return FakeChannel(u)..neverReady = true;
    },
    faceCapture: () => face ?? FakeFaceCapture(),
    voiceCapture: () => voice ?? FakeVoiceCapture(),
    sceneCamera: () => d.scene,
    poseSource: () => d.pose,
    witnessRunner: (betId) => d.runners[betId] = FakeWitnessRunner(betId)
      ..camera = d.scene
      ..registerError = d.registerError
      ..endGate = d.endGate,
    startSignal: () => d.signal,
    audioOut: d.audio,
    linkOpener: (u) async {
      d.links.add(u);
      return true;
    },
    localNotices: d.notices,
    screenAwake: d.awake,
  );
}

String toHexSeed() => kSeed.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

/// Pumps the app at a phone-sized surface and bootstraps the controller.
Future<AppController> pumpApp(WidgetTester tester, AppController c) async {
  await tester.binding.setSurfaceSize(const Size(390, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(VerdictApp(controller: c));
  await tester.runAsync(c.bootstrap);
  await tester.pumpAndSettle();
  return c;
}
