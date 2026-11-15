import 'package:flutter/widgets.dart';

import '../api/api_error.dart';
import '../wallet/wallet.dart';

/// Busy/error handling for screen actions. Errors show only §12.8
/// messages; a dismissed passkey prompt shows nothing.
mixin Guarded<T extends StatefulWidget> on State<T> {
  String? error;

  /// The action currently running (null = idle).
  String? busyTag;

  bool get busy => busyTag != null;
  bool busyWith(String tag) => busyTag == tag;

  /// Runs [f] once at a time. Returns null on failure.
  Future<R?> guard<R>(String tag, Future<R> Function() f, {bool exclusive = true}) async {
    if (exclusive && busy) return null;
    setState(() {
      busyTag = tag;
      error = null;
    });
    try {
      return await f();
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } on WalletLockedException {
      // dismissed
    } catch (e) {
      if (mounted) setState(() => error = ApiException('INTERNAL').message);
    } finally {
      if (mounted && busyTag == tag) setState(() => busyTag = null);
    }
    return null;
  }

  void showError(String code) {
    if (mounted) setState(() => error = ApiException(code).message);
  }

  void clearError() {
    if (mounted && error != null) setState(() => error = null);
  }
}
