import 'package:url_launcher/url_launcher.dart';

/// Opens a Receipt URL in an external browser (CONTRACTS.md §12.11).
typedef LinkOpener = Future<bool> Function(Uri uri);

Future<bool> openExternal(Uri uri) async {
  try {
    return await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    return false;
  }
}
