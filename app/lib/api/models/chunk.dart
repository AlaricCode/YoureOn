import '../../core/bytes.dart';
import '../../evidence/hash_chain.dart';
import 'json.dart';

/// Body format of a chunk (CONTRACTS.md §7.1, §12.3).
enum BodyFormat {
  mp4('mp4'),
  mjpeg('mjpeg'),
  wav('wav'),
  json('json');

  const BodyFormat(this.wire);
  final String wire;
}

/// Hash record for `POST /bets/:id/chunks` (posted before the body, §7.2).
class ChunkRecord {
  const ChunkRecord({
    required this.witnessKey,
    required this.chunk,
    required this.bodyFormat,
    required this.isFinal,
    this.widthPx,
    this.heightPx,
    this.orientation,
  });

  final String witnessKey; // base58
  final SealedChunk chunk;
  final BodyFormat bodyFormat;
  final bool isFinal;
  final int? widthPx;
  final int? heightPx;
  final String? orientation;

  Json toJson() => {
        'witness_key': witnessKey,
        'index': chunk.index,
        'kind': chunk.kind.wire,
        'body_format': bodyFormat.wire,
        if (widthPx != null) 'width_px': widthPx,
        if (heightPx != null) 'height_px': heightPx,
        if (orientation != null) 'orientation': orientation,
        'start_ms': chunk.startMs,
        'duration_ms': chunk.durationMs,
        'body_sha256': toHex(chunk.bodySha256),
        'chunk_hash': toHex(chunk.chunkHash),
        'prev_hash': toHex(chunk.prevHash),
        'sig_b64': toB64(chunk.signature),
        'final': isFinal,
      };
}

class ChunkAccepted {
  const ChunkAccepted({required this.accepted, required this.uploadUrl});
  final bool accepted;
  final String uploadUrl;

  factory ChunkAccepted.fromJson(Object? v) {
    final j = asJson(v);
    return ChunkAccepted(accepted: asBool(j['accepted']), uploadUrl: asString(j['upload_url']));
  }
}

class WitnessRegistered {
  const WitnessRegistered({required this.witnessId, required this.label});
  final String witnessId;
  final String label;

  factory WitnessRegistered.fromJson(Object? v) {
    final j = asJson(v);
    return WitnessRegistered(witnessId: asString(j['witness_id']), label: asString(j['label']));
  }
}
