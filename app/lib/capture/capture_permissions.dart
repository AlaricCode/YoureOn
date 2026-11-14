import 'package:flutter/services.dart' show MissingPluginException, PlatformException;
import 'package:permission_handler/permission_handler.dart';

/// The two capture devices the app asks access for.
enum CaptureDevice { camera, microphone }

/// Result of asking for a device.
enum DeviceAccess {
  /// Allowed.
  granted,

  /// Not allowed yet; asking again shows the system prompt again.
  denied,

  /// Denied for good ("Don't ask again", or restricted): only the system
  /// settings can change it.
  blocked,
}

/// Camera / microphone permission (the system "Allow Verdict to…" prompt).
/// Swappable for tests via [instance].
abstract class CapturePermissions {
  static CapturePermissions instance = const PluginCapturePermissions();

  /// Shows the system prompt if the user has not answered yet.
  Future<DeviceAccess> request(CaptureDevice device);

  /// Current state, without a prompt.
  Future<DeviceAccess> status(CaptureDevice device);

  /// Opens this app's page in the system settings.
  Future<void> openSettings();
}

/// [CapturePermissions] backed by `permission_handler`. Where the plugin is
/// not available (widget tests, desktop) access counts as granted and the
/// camera / recorder plugins report their own errors.
class PluginCapturePermissions implements CapturePermissions {
  const PluginCapturePermissions();

  static Permission _permission(CaptureDevice d) =>
      d == CaptureDevice.camera ? Permission.camera : Permission.microphone;

  static DeviceAccess _map(PermissionStatus s) {
    if (s.isGranted || s.isLimited) return DeviceAccess.granted;
    if (s.isPermanentlyDenied || s.isRestricted) return DeviceAccess.blocked;
    return DeviceAccess.denied;
  }

  static Future<DeviceAccess> _guard(Future<PermissionStatus> Function() f) async {
    try {
      return _map(await f());
    } on MissingPluginException {
      return DeviceAccess.granted;
    } on PlatformException {
      return DeviceAccess.granted;
    }
  }

  @override
  Future<DeviceAccess> request(CaptureDevice device) => _guard(() => _permission(device).request());

  @override
  Future<DeviceAccess> status(CaptureDevice device) => _guard(() => _permission(device).status);

  @override
  Future<void> openSettings() async {
    try {
      await openAppSettings();
    } on MissingPluginException {
      // nothing to open
    }
  }
}
