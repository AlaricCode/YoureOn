import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// A tiny in-test backend: route handlers keyed by "METHOD /path" (path
/// under /v1, without query). Records every request.
class FakeServer {
  final Map<String, Object? Function(http.Request req)> routes = {};
  final List<http.Request> requests = [];

  void on(String methodPath, Object? Function(http.Request req) handler) => routes[methodPath] = handler;

  /// Reply with an error envelope.
  static ErrorReply error(String code, [int status = 400]) => ErrorReply(code, status);

  MockClient get client => MockClient((req) async {
        requests.add(req);
        var path = req.url.path;
        if (path.startsWith('/v1')) path = path.substring(3);
        final h = routes['${req.method} $path'];
        if (h == null) {
          return http.Response(jsonEncode({'error': {'code': 'NOT_FOUND', 'message': 'nope'}}), 404);
        }
        final r = h(req);
        if (r is ErrorReply) {
          return http.Response(jsonEncode({'error': {'code': r.code, 'message': 'server text'}}), r.status);
        }
        if (r is http.Response) return r;
        return http.Response(jsonEncode(r), 200, headers: {'content-type': 'application/json'});
      });

  List<http.Request> called(String methodPath) {
    final parts = methodPath.split(' ');
    return requests
        .where((r) => r.method == parts[0] && r.url.path == '/v1${parts[1]}')
        .toList();
  }

  static Map<String, dynamic> body(http.Request r) => jsonDecode(r.body) as Map<String, dynamic>;
}

class ErrorReply {
  const ErrorReply(this.code, this.status);
  final String code;
  final int status;
}
