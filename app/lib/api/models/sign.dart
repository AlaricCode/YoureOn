import 'json.dart';

/// `{ sign: { tx_id, message_b64, expires_at_ms, summary } }` (CONTRACTS.md §12.1).
class SignRequest {
  const SignRequest({
    required this.txId,
    required this.messageB64,
    required this.expiresAtMs,
    required this.summary,
  });

  final String txId;
  final String messageB64; // serialized Solana message
  final int expiresAtMs;
  final String summary; // e.g. "Stake $5.00"

  factory SignRequest.fromJson(Object? v) {
    final j = asJson(v, 'sign');
    return SignRequest(
      txId: asString(j['tx_id']),
      messageB64: asString(j['message_b64']),
      expiresAtMs: asInt(j['expires_at_ms']),
      summary: asString(j['summary']),
    );
  }

  bool expiredAt(int nowMs) => expiresAtMs > 0 && nowMs >= expiresAtMs;
}

/// `POST /tx/:tx_id/submit` response.
class TxResult {
  const TxResult({required this.confirmed, this.signature, this.errorCode});

  final bool confirmed;
  final String? signature;
  final String? errorCode;

  factory TxResult.fromJson(Object? v) {
    final j = asJson(v);
    final status = asString(j['status']);
    final err = j['error'] == null ? null : asJson(j['error']);
    return TxResult(
      confirmed: status == 'confirmed',
      signature: asStringOrNull(j['signature']),
      errorCode: err == null ? null : asStringOrNull(err['code']),
    );
  }
}
