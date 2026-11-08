import 'package:camera/camera.dart';

import '../ws/ws_messages.dart';
import 'chunk_uploader.dart';

/// This phone's witnesses for one bet, as seen by the Record screen
/// (implemented by `WitnessSession`; faked in widget tests).
abstract class WitnessRunner {
  /// Registers an `audio` witness, plus `camera` on the viewfinder phone.
  /// Returns the witness labels.
  Future<List<String>> register({required bool camera});

  /// Starts recording on WS `start`.
  Future<void> begin(WsStart start, {CameraController? controller, CameraMeta? cameraMeta});

  /// End: keeps recording `TAIL_MS`, then seals the final chunks and drains
  /// uploads.
  Future<void> end();

  bool get recording;

  /// Chunks sealed so far across this phone's witnesses.
  int get sealedChunks;

  /// First non-retryable upload error (§12.8 code), if any.
  String? get uploadError;
}
