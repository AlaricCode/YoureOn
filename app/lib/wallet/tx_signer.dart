import '../api/api_client.dart';
import '../api/api_error.dart';
import '../api/models/sign.dart';
import 'wallet.dart';

/// The sign → submit loop of CONTRACTS.md §12.1.
///
/// [request] produces a sign payload (e.g. `() => api.fund(betId)`). On
/// `TX_EXPIRED` — local expiry or a server reply — it is re-requested once,
/// automatically. A failed transaction throws [ApiException] with the
/// server's code (default `TX_FAILED`).
class TxSigner {
  TxSigner({required this.api, required this.wallet, int Function()? nowMs})
      : _nowMs = nowMs ?? (() => DateTime.now().millisecondsSinceEpoch);

  final ApiClient api;
  final Wallet wallet;
  final int Function() _nowMs;

  /// [fresh]: always show the passkey prompt (stake, pay, bond, World
  /// bet), never reuse the unlock window.
  Future<TxResult> run(Future<SignRequest> Function() request, {SignRequest? first, bool fresh = false}) async {
    var sign = first ?? await request();
    for (var attempt = 0;; attempt++) {
      try {
        return await _once(sign, fresh: fresh);
      } on ApiException catch (e) {
        if (e.code != 'TX_EXPIRED' || attempt >= 1) rethrow;
        sign = await request();
      }
    }
  }

  Future<TxResult> _once(SignRequest sign, {required bool fresh}) async {
    if (sign.expiredAt(_nowMs())) throw ApiException('TX_EXPIRED');
    final sig = await wallet.signTxMessage(sign.messageB64, summary: sign.summary, fresh: fresh);
    final res = await api.submitTx(sign.txId, sig);
    if (!res.confirmed) throw ApiException(res.errorCode ?? 'TX_FAILED');
    return res;
  }
}
