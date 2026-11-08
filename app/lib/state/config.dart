/// Build-time configuration (`--dart-define`).
///
/// - `VERDICT_API`: backend root without `/v1` (default: the Android
///   emulator's host loopback).
/// - `VERDICT_GOOGLE`: `mock` (default; credential `mock:<email>`, §12.3).
class AppConfig {
  const AppConfig({required this.apiBaseUrl, this.googleMode = 'mock'});

  final String apiBaseUrl;
  final String googleMode;

  static const AppConfig fromEnvironment = AppConfig(
    apiBaseUrl: String.fromEnvironment('VERDICT_API', defaultValue: 'http://10.0.2.2:8787'),
    googleMode: String.fromEnvironment('VERDICT_GOOGLE', defaultValue: 'mock'),
  );
}
