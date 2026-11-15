import 'dart:async';
import 'dart:convert';

import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// In-memory WebSocketChannel: the test plays the server side.
class FakeChannel extends StreamChannelMixin<dynamic> implements WebSocketChannel {
  FakeChannel(this.uri);
  final Uri uri;
  final fromServer = StreamController<dynamic>();
  final sent = <Map<String, dynamic>>[];
  late final _sink = _Sink(this);

  @override
  Stream<dynamic> get stream => fromServer.stream;

  @override
  WebSocketSink get sink => _sink;

  /// Completes immediately unless [neverReady] (widget tests: no timers).
  bool neverReady = false;

  @override
  Future<void> get ready => neverReady ? Completer<void>().future : Future.value();

  @override
  String? get protocol => null;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  void push(Map<String, dynamic> m) => fromServer.add(jsonEncode(m));
  Future<void> drop() => fromServer.close();
}

class _Sink implements WebSocketSink {
  _Sink(this.ch);
  final FakeChannel ch;
  @override
  void add(dynamic data) => ch.sent.add(jsonDecode(data as String) as Map<String, dynamic>);
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> addStream(Stream<dynamic> stream) async {}
  @override
  Future<void> close([int? closeCode, String? closeReason]) async {}
  @override
  Future<void> get done => Future.value();
}

