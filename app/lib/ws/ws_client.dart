import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/bytes.dart';
import 'ws_messages.dart';

typedef ChannelFactory = WebSocketChannel Function(Uri uri);

/// App WebSocket (CONTRACTS.md §12.4).
///
/// - Keeps a set of subscribed topics and re-subscribes after every
///   reconnect; snapshots sent on subscribe are treated as truth.
/// - Sends `ping` every 20 s (the server closes after 60 s of silence).
/// - Reconnects with capped exponential backoff until [close] is called.
class WsClient {
  WsClient({
    required this.baseUrl,
    required this.token,
    ChannelFactory? connect,
    this.pingInterval = const Duration(seconds: 20),
    this.maxBackoff = const Duration(seconds: 15),
  }) : _connect = connect ?? ((u) => WebSocketChannel.connect(u));

  final String baseUrl;
  final String token;
  final Duration pingInterval;
  final Duration maxBackoff;
  final ChannelFactory _connect;

  final _out = StreamController<WsMessage>.broadcast();
  final _connected = StreamController<bool>.broadcast();
  final Set<String> _topics = {};

  WebSocketChannel? _ch;
  StreamSubscription<dynamic>? _sub;
  Timer? _ping;
  Timer? _retry;
  int _attempt = 0;
  bool _closed = false;
  bool _isConnected = false;

  Stream<WsMessage> get messages => _out.stream;

  /// Emits true after each (re)connect and false on disconnect.
  Stream<bool> get connection => _connected.stream;
  bool get isConnected => _isConnected;
  Set<String> get topics => Set.unmodifiable(_topics);

  /// `{API}/v1/ws?token=…`, with http(s) mapped to ws(s).
  Uri get uri {
    final b = Uri.parse(baseUrl);
    final scheme = b.scheme == 'https' ? 'wss' : (b.scheme == 'http' ? 'ws' : b.scheme);
    final path = '${b.path.endsWith('/') ? b.path.substring(0, b.path.length - 1) : b.path}/v1/ws';
    return b.replace(scheme: scheme, path: path, queryParameters: {'token': token});
  }

  void open() {
    if (_closed || _ch != null) return;
    final WebSocketChannel ch;
    try {
      ch = _connect(uri);
    } catch (_) {
      _scheduleReconnect();
      return;
    }
    _ch = ch;
    _sub = ch.stream.listen(
      _onData,
      onError: (Object _) => _onDown(),
      onDone: _onDown,
      cancelOnError: true,
    );
    ch.ready.then((_) {
      if (_ch != ch) return;
      _attempt = 0;
      _isConnected = true;
      _connected.add(true);
      if (_topics.isNotEmpty) _send({'type': 'subscribe', 'topics': _topics.toList()});
      _ping?.cancel();
      _ping = Timer.periodic(pingInterval, (_) => _send({'type': 'ping'}));
    }, onError: (Object _) => _onDown());
  }

  void subscribe(Iterable<String> topics) {
    final fresh = topics.where(_topics.add).toList();
    if (fresh.isNotEmpty && _isConnected) _send({'type': 'subscribe', 'topics': fresh});
  }

  void unsubscribe(Iterable<String> topics) {
    final gone = topics.where(_topics.remove).toList();
    if (gone.isNotEmpty && _isConnected) _send({'type': 'unsubscribe', 'topics': gone});
  }

  /// `scene.frame`: 10 fps JPEG ≤ 640 px long side.
  void sendSceneFrame(String betId, List<int> jpeg, int tMs) =>
      _send({'type': 'scene.frame', 'bet_id': betId, 'jpeg_b64': toB64(jpeg), 't_ms': tMs});

  /// `recording`: reply to `start` once this witness records.
  void sendRecording(String betId, String witnessKey) =>
      _send({'type': 'recording', 'bet_id': betId, 'witness_key': witnessKey});

  bool _send(Map<String, Object?> msg) {
    final ch = _ch;
    if (ch == null || !_isConnected) return false;
    try {
      ch.sink.add(jsonEncode(msg));
      return true;
    } catch (_) {
      return false;
    }
  }

  void _onData(dynamic data) {
    if (_closed) return;
    try {
      final text = data is String ? data : utf8.decode(data as List<int>);
      _out.add(WsMessage.fromJson(jsonDecode(text)));
    } catch (_) {
      // Malformed frames are dropped; the next snapshot corrects state.
    }
  }

  void _onDown() {
    if (_closed) return;
    _ping?.cancel();
    _ping = null;
    _sub?.cancel();
    _sub = null;
    final ch = _ch;
    _ch = null;
    try {
      ch?.sink.close();
    } catch (_) {}
    if (_isConnected) {
      _isConnected = false;
      _connected.add(false);
    }
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closed) return;
    _retry?.cancel();
    final ms = (500 * (1 << (_attempt.clamp(0, 6)))).clamp(500, maxBackoff.inMilliseconds);
    _attempt++;
    _retry = Timer(Duration(milliseconds: ms), open);
  }

  Future<void> close() async {
    _closed = true;
    _retry?.cancel();
    _ping?.cancel();
    await _sub?.cancel();
    try {
      await _ch?.sink.close();
    } catch (_) {}
    _ch = null;
    _isConnected = false;
    await _out.close();
    await _connected.close();
  }
}
