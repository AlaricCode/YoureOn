import 'dart:async';

import 'package:flutter/widgets.dart';

import '../ws/ws_messages.dart';
import 'app_controller.dart';
import 'app_scope.dart';

/// Holds WS topic subscriptions for a screen's lifetime and delivers its
/// messages (CONTRACTS.md §12.4; snapshots on subscribe are truth).
mixin WsWatch<T extends StatefulWidget> on State<T> {
  final List<TopicLease> _leases = [];
  StreamSubscription<WsMessage>? _wsSub;

  /// Starts listening (idempotent for the listener) and adds [topics].
  void watchWs(Iterable<String> topics, void Function(WsMessage m) onMessage) {
    final app = AppScope.read(context);
    _wsSub ??= app.wsMessages.listen((m) {
      if (mounted) onMessage(m);
    });
    _leases.add(app.watch(topics));
  }

  /// Drops every topic (the listener stays).
  void releaseTopics() {
    for (final l in _leases) {
      l.release();
    }
    _leases.clear();
  }

  AppController get app => AppScope.read(context);

  @override
  void dispose() {
    releaseTopics();
    _wsSub?.cancel();
    super.dispose();
  }
}
