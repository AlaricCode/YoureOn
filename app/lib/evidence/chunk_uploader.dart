import 'dart:async';
import 'dart:typed_data';

import '../api/api_client.dart';
import '../api/api_error.dart';
import '../api/models/chunk.dart';
import '../contracts/constants.dart';
import 'hash_chain.dart';

/// Camera metadata sent with camera chunk records (must match calibration).
class CameraMeta {
  const CameraMeta({required this.widthPx, required this.heightPx, required this.orientation});
  final int widthPx;
  final int heightPx;
  final String orientation;
}

/// Progress of one witness's upload pipeline.
class UploadStatus {
  const UploadStatus({required this.sealed, required this.uploaded, this.lastError});
  final int sealed;
  final int uploaded;
  final String? lastError; // §12.8 code
}

/// Seals chunk bodies into the witness hash chain and uploads them in order:
/// hash record first, then the body (CONTRACTS.md §7.2 "Upload order").
///
/// Sealing happens immediately on [submit] (so the hash record can go out
/// as soon as the chunk closes); uploads run strictly sequentially and are
/// retried on transport errors. Non-retryable codes stop the pipeline.
class ChunkUploader {
  ChunkUploader({
    required this.api,
    required this.betId,
    required this.chain,
    required this.format,
    this.camera,
    this.maxAttempts = 6,
    this.retryBase = const Duration(milliseconds: 500),
  });

  final ApiClient api;
  final String betId;
  final ChunkChain chain;
  final BodyFormat format;
  final CameraMeta? camera;
  final int maxAttempts;
  final Duration retryBase;

  final _status = StreamController<UploadStatus>.broadcast();
  Future<void> _tail = Future.value();
  int _sealed = 0;
  int _uploaded = 0;
  String? _fatal;
  bool _finalSubmitted = false;

  Stream<UploadStatus> get status => _status.stream;
  int get sealed => _sealed;
  int get uploaded => _uploaded;
  String? get fatalError => _fatal;
  String get witnessKey => chain.witnessKey.address;

  static const Set<String> _retryable = {'INTERNAL', 'RATE_LIMITED'};

  /// Seals [body] and queues its upload. Returns the sealed chunk.
  Future<SealedChunk> submit(Uint8List body, {required int startMs, required int durationMs, required bool isFinal}) async {
    if (_finalSubmitted) throw StateError('final chunk already submitted');
    if (body.length > MAX_CHUNK_BODY_BYTES) throw ApiException('CHUNK_TOO_LARGE');
    if (isFinal) _finalSubmitted = true;
    final sealedFuture = chain.seal(body: body, startMs: startMs, durationMs: durationMs);
    _sealed++;
    final record = sealedFuture.then((c) => ChunkRecord(
          witnessKey: witnessKey,
          chunk: c,
          bodyFormat: format,
          isFinal: isFinal,
          widthPx: camera?.widthPx,
          heightPx: camera?.heightPx,
          orientation: camera?.orientation,
        ));
    _tail = _tail.then((_) => _upload(record, body)).catchError((Object _) {
      _fatal ??= 'INTERNAL';
      _emit(error: _fatal);
    });
    _emit();
    return sealedFuture;
  }

  /// Completes when every queued chunk has been uploaded (or the pipeline
  /// stopped on a fatal error).
  Future<void> drain() => _tail;

  Future<void> _upload(Future<ChunkRecord> recordF, Uint8List body) async {
    if (_fatal != null) return;
    final record = await recordF;
    final accepted = await _retry(() => api.postChunk(betId, record));
    if (accepted == null) return;
    final ok = await _retry(() => api.putChunkBody(
          betId,
          witnessKey,
          record.chunk.index,
          body,
          uploadUrl: accepted.uploadUrl,
        ).then((_) => true));
    if (ok == null) return;
    _uploaded++;
    _emit();
  }

  Future<T?> _retry<T>(Future<T> Function() f) async {
    for (var attempt = 0;; attempt++) {
      try {
        return await f();
      } on ApiException catch (e) {
        if (!_retryable.contains(e.code) || attempt + 1 >= maxAttempts) {
          _fatal = e.code;
          _emit(error: e.code);
          return null;
        }
        _emit(error: e.code);
        await Future<void>.delayed(retryBase * (1 << attempt.clamp(0, 5)));
      }
    }
  }

  void _emit({String? error}) {
    if (_status.isClosed) return;
    _status.add(UploadStatus(sealed: _sealed, uploaded: _uploaded, lastError: error ?? _fatal));
  }

  Future<void> close() async {
    await drain();
    await _status.close();
  }
}
