import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'api_error.dart';
import 'models/json.dart';

/// Low-level HTTP for `{API}/v1` (CONTRACTS.md §12): bearer auth, JSON
/// bodies, `{error:{code,message}}` envelopes mapped to [ApiException].
class ApiTransport {
  ApiTransport({
    required this.baseUrl,
    http.Client? client,
    this.timeout = const Duration(seconds: 30),
  }) : _client = client ?? http.Client();

  /// Server root without `/v1`, e.g. `http://10.0.2.2:8787`.
  final String baseUrl;
  final Duration timeout;
  final http.Client _client;

  String? token;

  /// Called on any `UNAUTHORIZED` reply (the app signs out).
  void Function()? onUnauthorized;

  Uri uri(String path, [Map<String, String>? query]) {
    final root = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
    final u = Uri.parse('$root/v1$path');
    if (query == null || query.isEmpty) return u;
    return u.replace(queryParameters: {...u.queryParameters, ...query});
  }

  /// Resolves an absolute or API-relative URL (e.g. `audio_url`, `upload_url`).
  ///
  /// Absolute URLs under `/v1/` are rebased onto [baseUrl]: the backend
  /// builds them from its `PUBLIC_URL` (default `http://127.0.0.1:<port>`),
  /// which a phone or emulator can't reach, and the bearer token must only
  /// go to the configured API origin. Other absolute URLs (CDNs, explorers)
  /// are kept.
  Uri resolve(String url) {
    final u = Uri.parse(url);
    final root = Uri.parse(baseUrl);
    if (u.hasScheme) {
      if (!u.path.startsWith('/v1/')) return u;
      return root.replace(path: u.path, query: u.hasQuery ? u.query : null, fragment: null);
    }
    if (url.startsWith('/v1/')) return root.resolve(url);
    if (url.startsWith('/')) return root.resolve('/v1$url');
    return root.resolve('/v1/$url');
  }

  Map<String, String> _headers({String? contentType, bool auth = true}) => {
        if (contentType != null) 'content-type': contentType,
        'accept': 'application/json',
        if (auth && token != null) 'authorization': 'Bearer $token',
      };

  Future<Object?> getJson(String path, {Map<String, String>? query, bool auth = true}) =>
      _send(() => _client.get(uri(path, query), headers: _headers(auth: auth)));

  Future<Object?> postJson(String path, [Object? body, bool auth = true]) => _send(
        () => _client.post(
          uri(path),
          headers: _headers(contentType: 'application/json', auth: auth),
          body: jsonEncode(body ?? const <String, Object?>{}),
        ),
      );

  /// [postJson] with its own [timeout], for calls the backend needs longer
  /// to answer (enrollment: the face/voice model runs on every capture).
  Future<Object?> postJsonSlow(String path, Object body, {required Duration timeout}) => _send(
        () => _client.post(
          uri(path),
          headers: _headers(contentType: 'application/json'),
          body: jsonEncode(body),
        ),
        timeout: timeout,
      );

  Future<Object?> patchJson(String path, Object body) => _send(
        () => _client.patch(
          uri(path),
          headers: _headers(contentType: 'application/json'),
          body: jsonEncode(body),
        ),
      );

  Future<Object?> putJson(String path, Object body) => _send(
        () => _client.put(
          uri(path),
          headers: _headers(contentType: 'application/json'),
          body: jsonEncode(body),
        ),
      );

  Future<Object?> delete(String path) =>
      _send(() => _client.delete(uri(path), headers: _headers()));

  /// PUT raw bytes (chunk bodies, scene crops). [target] may be a path under
  /// `/v1` or a server-supplied URL.
  Future<Object?> putBytes(String target, Uint8List body, {required String contentType}) {
    final u = _target(target);
    return _send(() => _client.put(u, headers: _headers(contentType: contentType), body: body));
  }

  /// GET raw bytes (mp3/wav, chunk bodies, exhibits).
  Future<Uint8List> getBytes(String pathOrUrl) async {
    final u = _target(pathOrUrl);
    final res = await _raw(() => _client.get(u, headers: _headers()));
    if (res.statusCode >= 200 && res.statusCode < 300) return res.bodyBytes;
    throw _errorFrom(res);
  }

  /// A route path (`/bets/...`, prefixed with `/v1`) or a server-supplied
  /// URL (absolute, or already starting with `/v1/`).
  Uri _target(String t) =>
      Uri.parse(t).hasScheme || t.startsWith('/v1/') ? resolve(t) : uri(t);

  Future<http.Response> _raw(Future<http.Response> Function() f, {Duration? timeout}) async {
    try {
      return await f().timeout(timeout ?? this.timeout);
    } on TimeoutException catch (e) {
      throw ApiException.internal(e);
    } on http.ClientException catch (e) {
      throw ApiException.internal(e);
    } on Exception catch (e) {
      // SocketException and friends (dart:io is not imported so this file
      // stays platform-neutral).
      throw ApiException.internal(e);
    }
  }

  Future<Object?> _send(Future<http.Response> Function() f, {Duration? timeout}) async {
    final res = await _raw(f, timeout: timeout);
    if (res.statusCode == 204) return null;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (res.bodyBytes.isEmpty) return null;
      try {
        return jsonDecode(utf8.decode(res.bodyBytes));
      } on FormatException catch (e) {
        throw ApiException.internal(e, status: res.statusCode);
      }
    }
    throw _errorFrom(res);
  }

  ApiException _errorFrom(http.Response res) {
    String code;
    String? msg;
    try {
      final j = asJson(jsonDecode(utf8.decode(res.bodyBytes)));
      final e = asJson(j['error']);
      code = asString(e['code']);
      msg = e['message'] as String?;
    } catch (_) {
      code = switch (res.statusCode) {
        401 => 'UNAUTHORIZED',
        404 => 'NOT_FOUND',
        413 => 'CHUNK_TOO_LARGE',
        429 => 'RATE_LIMITED',
        _ => 'INTERNAL',
      };
    }
    if (code == 'UNAUTHORIZED') onUnauthorized?.call();
    return ApiException(code, status: res.statusCode, serverMessage: msg);
  }

  void close() => _client.close();
}

/// Wraps a decode step so shape errors surface as `INTERNAL`.
T decode<T>(Object? raw, T Function(Object? v) f) {
  try {
    return f(raw);
  } on FormatException catch (e) {
    throw ApiException.internal(e);
  } on TypeError catch (e) {
    throw ApiException.internal(e);
  }
}
