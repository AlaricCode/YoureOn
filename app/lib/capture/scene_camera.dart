import 'dart:async';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../evidence/chunk_uploader.dart';
import 'frame_convert.dart';
import 'image_utils.dart';

/// One scene frame: upright JPEG ≤ 640 px long side, `t_ms` since the frame
/// stream started (CONTRACTS.md §12.4 `scene.frame`).
class SceneFrame {
  const SceneFrame(this.jpeg, this.tMs);
  final Uint8List jpeg;
  final int tMs;
}

/// The rear camera used by Scene check and Record. One capture
/// configuration (portrait, `ResolutionPreset.high` ≥ 720p) so that the
/// recording matches the calibration (`CAMERA_MISMATCH`, §5.2).
abstract class SceneCamera {
  Future<void> open();
  bool get isOpen;

  /// Upright capture size and orientation (calibration `camera`, chunk
  /// metadata).
  CameraMeta? get meta;

  /// Live preview filling its box like `BoxFit.cover`.
  Widget preview();

  /// Frames at up to [fps]; cancelling the subscription stops the stream.
  Stream<SceneFrame> frames({int fps = 10});

  /// The latest full frame as an upright JPEG (the placement reference).
  Future<Uint8List> still();

  /// The controller for MP4 camera-witness recording (null in fakes).
  CameraController? get controller;

  Future<void> close();
}

class DeviceSceneCamera implements SceneCamera {
  CameraController? _c;
  CameraDescription? _desc;
  CameraMeta? _meta;
  Uint8List? _last;
  StreamController<SceneFrame>? _frames;

  @override
  CameraController? get controller => _c;

  @override
  bool get isOpen => _c?.value.isInitialized ?? false;

  @override
  CameraMeta? get meta => _meta;

  @override
  Future<void> open() async {
    if (isOpen) return;
    final cams = await availableCameras();
    if (cams.isEmpty) throw StateError('no camera');
    final cam = cams.firstWhere((c) => c.lensDirection == CameraLensDirection.back, orElse: () => cams.first);
    final c = CameraController(
      cam,
      ResolutionPreset.high,
      enableAudio: false,
      imageFormatGroup: Platform.isIOS ? ImageFormatGroup.bgra8888 : ImageFormatGroup.yuv420,
    );
    await c.initialize();
    await c.lockCaptureOrientation(DeviceOrientation.portraitUp);
    _c = c;
    _desc = cam;
    final ps = c.value.previewSize ?? const Size(1280, 720);
    final long = ps.width > ps.height ? ps.width : ps.height;
    final short = ps.width > ps.height ? ps.height : ps.width;
    _meta = CameraMeta(widthPx: short.round(), heightPx: long.round(), orientation: 'portrait');
  }

  @override
  Widget preview() {
    final c = _c;
    final m = _meta;
    if (c == null || m == null || !c.value.isInitialized) return const SizedBox.expand();
    return ClipRect(
      child: FittedBox(
        fit: BoxFit.cover,
        child: SizedBox(width: m.widthPx.toDouble(), height: m.heightPx.toDouble(), child: CameraPreview(c)),
      ),
    );
  }

  @override
  Stream<SceneFrame> frames({int fps = 10}) {
    final out = StreamController<SceneFrame>();
    final clock = Stopwatch();
    final minGap = 1000 ~/ fps;
    var busy = false;
    var lastAt = -minGap;

    Future<void> onImage(CameraImage im) async {
      if (busy || out.isClosed) return;
      final now = clock.elapsedMilliseconds;
      if (now - lastAt < minGap) return;
      busy = true;
      lastAt = now;
      try {
        final raw = _copy(im);
        if (raw == null) return;
        final jpeg = await compute(_encode, raw);
        _last = jpeg;
        if (!out.isClosed) out.add(SceneFrame(jpeg, now));
      } catch (_) {
        // A dropped frame; the next one follows within 100 ms.
      } finally {
        busy = false;
      }
    }

    out.onListen = () async {
      final c = _c;
      if (c == null) return;
      clock.start();
      if (!c.value.isStreamingImages) await c.startImageStream(onImage);
    };
    out.onCancel = () async {
      final c = _c;
      if (c != null && c.value.isStreamingImages) await c.stopImageStream();
    };
    _frames = out;
    return out.stream;
  }

  RawFrame? _copy(CameraImage im) {
    final RawFormat format;
    switch (im.format.group) {
      case ImageFormatGroup.yuv420:
        format = im.planes.length >= 3 ? RawFormat.yuv420 : RawFormat.nv21;
      case ImageFormatGroup.nv21:
        format = RawFormat.nv21;
      case ImageFormatGroup.bgra8888:
        format = RawFormat.bgra8888;
      default:
        return null;
    }
    return RawFrame(
      width: im.width,
      height: im.height,
      format: format,
      planes: [for (final p in im.planes) Uint8List.fromList(p.bytes)],
      rowStrides: [for (final p in im.planes) p.bytesPerRow],
      pixelStrides: [for (final p in im.planes) p.bytesPerPixel ?? 1],
      rotation: uprightRotation(
        width: im.width,
        height: im.height,
        portrait: true,
        sensorDegrees: _desc?.sensorOrientation ?? 90,
      ),
    );
  }

  @override
  Future<Uint8List> still() async {
    final last = _last;
    if (last != null) return last;
    final c = _c;
    if (c == null) throw StateError('camera not open');
    final shot = await c.takePicture();
    final up = await toUploadJpeg(await shot.readAsBytes());
    try {
      await File(shot.path).delete();
    } catch (_) {}
    return _last = up.jpeg;
  }

  @override
  Future<void> close() async {
    await _frames?.close();
    _frames = null;
    final c = _c;
    _c = null;
    _last = null;
    if (c != null) {
      if (c.value.isStreamingImages) {
        try {
          await c.stopImageStream();
        } catch (_) {}
      }
      await c.dispose();
    }
  }
}

Uint8List _encode(RawFrame f) => rawToJpeg(f);
