import 'dart:async';
import 'dart:math' as math;

import 'package:sensors_plus/sensors_plus.dart';

import '../api/models/calibration.dart';
import '../contracts/constants.dart';

/// Camera pose from gravity (phone accelerometer, m/s² in device axes:
/// x right, y up, z out of the screen). Integer centi-degrees (§5.2).
///
/// - pitch: tilt of the screen away from vertical (0 = upright, positive =
///   top edge leaning back);
/// - roll: rotation in the screen plane (0 = upright portrait).
CameraPose poseFromGravity(double x, double y, double z) {
  const k = 18000 / math.pi;
  final pitch = math.atan2(z, math.sqrt(x * x + y * y)) * k;
  final roll = math.atan2(x, y) * k;
  return CameraPose(pitchCdeg: pitch.round(), rollCdeg: roll.round());
}

/// Largest angular difference between two poses (roll wraps at ±180°).
int poseDriftCdeg(CameraPose a, CameraPose b) {
  final dp = (a.pitchCdeg - b.pitchCdeg).abs();
  var dr = (a.rollCdeg - b.rollCdeg).abs() % 36000;
  if (dr > 18000) dr = 36000 - dr;
  return dp > dr ? dp : dr;
}

/// "Camera moved" (CONTRACTS.md §12.10): drift beyond
/// `CAMERA_POSE_DRIFT_CDEG` from the calibrated pose.
bool cameraMoved(CameraPose? calibrated, CameraPose? current) =>
    calibrated != null && current != null && poseDriftCdeg(calibrated, current) > CAMERA_POSE_DRIFT_CDEG;

/// Streams the phone's pose (smoothed).
abstract class PoseSource {
  /// Latest pose, or null before the first sample / without sensors.
  CameraPose? get current;
  Stream<CameraPose> get poses;
  void start();
  Future<void> stop();
}

class SensorPoseSource implements PoseSource {
  SensorPoseSource({this.alpha = 0.2});

  /// Low-pass weight of each new sample.
  final double alpha;

  StreamSubscription<AccelerometerEvent>? _sub;
  final _out = StreamController<CameraPose>.broadcast();
  double? _x, _y, _z;
  CameraPose? _current;

  @override
  CameraPose? get current => _current;

  @override
  Stream<CameraPose> get poses => _out.stream;

  @override
  void start() {
    if (_sub != null) return;
    try {
      _sub = accelerometerEventStream(samplingPeriod: SensorInterval.uiInterval).listen((e) {
        _x = _x == null ? e.x : _x! + alpha * (e.x - _x!);
        _y = _y == null ? e.y : _y! + alpha * (e.y - _y!);
        _z = _z == null ? e.z : _z! + alpha * (e.z - _z!);
        final p = _current = poseFromGravity(_x!, _y!, _z!);
        if (!_out.isClosed) _out.add(p);
      }, onError: (Object _) {});
    } catch (_) {
      // No accelerometer: pose stays null and "Camera moved" never shows.
    }
  }

  @override
  Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
    await _out.close();
  }
}

/// A fixed pose (tests, devices without sensors).
class FixedPoseSource implements PoseSource {
  FixedPoseSource([this.pose]);
  CameraPose? pose;
  final _out = StreamController<CameraPose>.broadcast();

  @override
  CameraPose? get current => pose;

  @override
  Stream<CameraPose> get poses => _out.stream;

  void set(CameraPose p) {
    pose = p;
    _out.add(p);
  }

  @override
  void start() {}

  @override
  Future<void> stop() async => _out.close();
}
