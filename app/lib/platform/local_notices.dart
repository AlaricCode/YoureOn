import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

/// On-device notifications ([D-29]: WS `notify` plus local notifications;
/// no push service). Shown while the app is in the background, and
/// scheduled for deadlines the phone already knows (consent).
abstract class LocalNotices {
  /// Initializes the plugin and asks for permission (Android 13+
  /// `POST_NOTIFICATIONS`, iOS alert/sound). Safe to call more than once.
  Future<void> init();

  /// Posts [title] now.
  Future<void> show(String title);

  /// Posts [title] at [at] (replaces an earlier schedule with the same [id]).
  Future<void> schedule(int id, String title, DateTime at);

  Future<void> cancel(int id);
}

/// `flutter_local_notifications` backed notices. Every call swallows
/// platform errors: a missing permission must never break the bet flow.
class PluginLocalNotices implements LocalNotices {
  PluginLocalNotices([FlutterLocalNotificationsPlugin? plugin]) : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  final FlutterLocalNotificationsPlugin _plugin;
  Future<bool>? _ready;
  int _nextId = 1;

  static const _channelId = 'verdict.notices';
  static const _details = NotificationDetails(
    android: AndroidNotificationDetails(
      _channelId,
      'Bets',
      importance: Importance.high,
      priority: Priority.high,
    ),
    iOS: DarwinNotificationDetails(presentAlert: true, presentSound: true),
  );

  @override
  Future<void> init() => _ensure();

  Future<bool> _ensure() => _ready ??= () async {
        try {
          tzdata.initializeTimeZones();
          await _plugin.initialize(
            settings: const InitializationSettings(
              android: AndroidInitializationSettings('@mipmap/ic_launcher'),
              iOS: DarwinInitializationSettings(
                requestAlertPermission: false,
                requestBadgePermission: false,
                requestSoundPermission: false,
              ),
            ),
          );
          await _plugin
              .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
              ?.requestNotificationsPermission();
          await _plugin
              .resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()
              ?.requestPermissions(alert: true, sound: true);
          return true;
        } catch (e) {
          debugPrint('local notices unavailable: $e');
          return false;
        }
      }();

  @override
  Future<void> show(String title) async {
    if (!await _ensure()) return;
    try {
      // Ids 1..9999 for immediate notices; scheduled ids come from callers
      // (>= 10000).
      final id = _nextId;
      _nextId = _nextId % 9999 + 1;
      await _plugin.show(id: id, title: title, notificationDetails: _details);
    } catch (e) {
      debugPrint('local notice failed: $e');
    }
  }

  @override
  Future<void> schedule(int id, String title, DateTime at) async {
    if (!await _ensure()) return;
    try {
      await _plugin.zonedSchedule(
        id: id,
        title: title,
        scheduledDate: tz.TZDateTime.from(at.toUtc(), tz.UTC),
        notificationDetails: _details,
        // Inexact needs no exact-alarm permission; callers schedule with a
        // lead time before the real deadline.
        androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
      );
    } catch (e) {
      debugPrint('local notice schedule failed: $e');
    }
  }

  @override
  Future<void> cancel(int id) async {
    if (!await _ensure()) return;
    try {
      await _plugin.cancel(id: id);
    } catch (_) {}
  }
}

/// No-op notices (tests, unsupported platforms).
class NoLocalNotices implements LocalNotices {
  const NoLocalNotices();
  @override
  Future<void> init() async {}
  @override
  Future<void> show(String title) async {}
  @override
  Future<void> schedule(int id, String title, DateTime at) async {}
  @override
  Future<void> cancel(int id) async {}
}
