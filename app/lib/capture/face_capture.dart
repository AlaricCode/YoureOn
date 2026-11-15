import 'dart:io';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/widgets.dart';
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';
import 'package:path_provider/path_provider.dart';

import 'image_utils.dart';

/// One detected face in a captured frame. bbox is normalized `0..10000` to
/// the full captured image (CONTRACTS.md §0.4).
class DetectedFace {
  const DetectedFace({required this.bbox, this.yawDeg, this.pitchDeg});
  final List<int> bbox;
  final double? yawDeg;
  final double? pitchDeg;

  int get area => (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
}

/// A captured full frame (JPEG, long side ≤ 640) and its faces.
class CapturedFrame {
  const CapturedFrame({required this.jpeg, required this.width, required this.height, required this.faces});
  final Uint8List jpeg;
  final int width;
  final int height;
  final List<DetectedFace> faces;

  DetectedFace? get largestFace {
    if (faces.isEmpty) return null;
    return faces.reduce((a, b) => a.area >= b.area ? a : b);
  }
}

/// Head-turn prompts of the enrollment / pay liveness challenge.
enum HeadPrompt {
  left('left', 'Turn left'),
  right('right', 'Turn right'),
  up('up', 'Look up'),
  down('down', 'Look down');

  const HeadPrompt(this.wire, this.label);
  final String wire;
  final String label;

  static HeadPrompt parse(String s) => values.firstWhere((p) => p.wire == s, orElse: () => left);

  /// Loose client-side check (the server decides liveness): the head is
  /// turned at least [minDeg] on the prompt's axis. The sign of ML Kit's
  /// angles depends on camera mirroring, so only the magnitude is checked.
  bool satisfiedBy(DetectedFace f, {double minDeg = 12}) {
    final v = (this == left || this == right) ? f.yawDeg : f.pitchDeg;
    return v != null && v.abs() >= minDeg;
  }
}

/// Camera + on-device face detection used by Enroll, Huddle scan and Pay.
abstract class FaceCapture {
  Future<void> open({bool front = true});
  bool get isOpen;
  Widget preview();
  Future<CapturedFrame> capture();
  Future<void> close();
}

class CameraFaceCapture implements FaceCapture {
  CameraController? _controller;
  FaceDetector? _detector;

  @override
  bool get isOpen => _controller?.value.isInitialized ?? false;

  CameraController? get controller => _controller;

  @override
  Future<void> open({bool front = true}) async {
    if (isOpen) return;
    final cams = await availableCameras();
    if (cams.isEmpty) throw StateError('no camera');
    final want = front ? CameraLensDirection.front : CameraLensDirection.back;
    final cam = cams.firstWhere((c) => c.lensDirection == want, orElse: () => cams.first);
    final c = CameraController(cam, ResolutionPreset.high, enableAudio: false, imageFormatGroup: ImageFormatGroup.jpeg);
    await c.initialize();
    _controller = c;
    _detector = FaceDetector(
      options: FaceDetectorOptions(performanceMode: FaceDetectorMode.accurate, minFaceSize: 0.15),
    );
  }

  @override
  Widget preview() {
    final c = _controller;
    if (c == null || !c.value.isInitialized) return const SizedBox.expand();
    return ClipRect(
      child: FittedBox(
        fit: BoxFit.cover,
        child: SizedBox(
          width: c.value.previewSize?.height ?? 1,
          height: c.value.previewSize?.width ?? 1,
          child: CameraPreview(c),
        ),
      ),
    );
  }

  @override
  Future<CapturedFrame> capture() async {
    final c = _controller;
    final d = _detector;
    if (c == null || d == null) throw StateError('camera not open');
    final shot = await c.takePicture();
    final raw = await shot.readAsBytes();
    final up = await toUploadJpeg(raw);
    // Detect on the upright, resized JPEG so the boxes share its frame.
    final dir = await getTemporaryDirectory();
    final f = File('${dir.path}/face_${DateTime.now().microsecondsSinceEpoch}.jpg');
    await f.writeAsBytes(up.jpeg, flush: true);
    try {
      final faces = await d.processImage(InputImage.fromFilePath(f.path));
      return CapturedFrame(
        jpeg: up.jpeg,
        width: up.width,
        height: up.height,
        faces: [
          for (final face in faces)
            DetectedFace(
              bbox: normalizeRect(
                face.boundingBox.left,
                face.boundingBox.top,
                face.boundingBox.right,
                face.boundingBox.bottom,
                up.width,
                up.height,
              ),
              yawDeg: face.headEulerAngleY,
              pitchDeg: face.headEulerAngleX,
            ),
        ],
      );
    } finally {
      try {
        await f.delete();
        await File(shot.path).delete();
      } catch (_) {}
    }
  }

  @override
  Future<void> close() async {
    final c = _controller;
    _controller = null;
    await c?.dispose();
    await _detector?.close();
    _detector = null;
  }
}

/// Pixel rect → normalized `[x0,y0,x1,y1]`: `floor(px * 10000 / size)`
/// clamped to `[0, 10000]` (§0.4).
List<int> normalizeRect(double l, double t, double r, double b, int width, int height) {
  int nx(double x) => (x.floor() * 10000 ~/ width).clamp(0, 10000);
  int ny(double y) => (y.floor() * 10000 ~/ height).clamp(0, 10000);
  return [nx(l), ny(t), nx(r), ny(b)];
}
