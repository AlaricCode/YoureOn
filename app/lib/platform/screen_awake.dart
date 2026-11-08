import 'package:flutter/foundation.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

/// Keeps the screen on while a capture screen is visible (Scene check,
/// Huddle, Record): phones lying on the table as witnesses must not
/// auto-lock, or the OS releases the camera and silences the microphone.
///
/// Holds are reference-counted so stacked screens can overlap.
abstract class ScreenAwake {
  void hold();
  void release();
}

class WakelockScreenAwake implements ScreenAwake {
  int _holds = 0;

  @override
  void hold() {
    if (_holds++ == 0) _set(true);
  }

  @override
  void release() {
    if (_holds == 0) return;
    if (--_holds == 0) _set(false);
  }

  void _set(bool on) {
    WakelockPlus.toggle(enable: on).catchError((Object e) {
      debugPrint('wakelock: $e');
    });
  }
}

/// Test double: counts holds.
class CountingScreenAwake implements ScreenAwake {
  int holds = 0;
  bool get on => holds > 0;

  @override
  void hold() => holds++;

  @override
  void release() {
    if (holds > 0) holds--;
  }
}
