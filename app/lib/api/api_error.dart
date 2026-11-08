import '../contracts/error_codes.dart';

/// An API failure carrying a §12.8 code. [message] is always the fixed
/// display message for [code], never the server's text.
class ApiException implements Exception {
  ApiException(this.code, {this.status, this.serverMessage, this.cause});

  /// Transport failure / unparseable response.
  factory ApiException.internal(Object cause, {int? status}) =>
      ApiException('INTERNAL', status: status, cause: cause);

  final String code;
  final int? status;
  final String? serverMessage; // informational only, never displayed
  final Object? cause;

  String get message => errorMessage(code);

  @override
  String toString() => 'ApiException($code, status: $status, server: $serverMessage, cause: $cause)';
}
