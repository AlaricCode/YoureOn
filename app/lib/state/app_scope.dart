import 'package:flutter/widgets.dart';

import 'app_controller.dart';

/// Provides the [AppController] to the widget tree.
class AppScope extends InheritedNotifier<AppController> {
  const AppScope({super.key, required AppController controller, required super.child})
      : super(notifier: controller);

  /// Subscribes the caller to controller changes.
  static AppController of(BuildContext context) {
    final s = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(s != null, 'AppScope missing');
    return s!.notifier!;
  }

  /// Reads without subscribing (for callbacks).
  static AppController read(BuildContext context) {
    final s = context.getInheritedWidgetOfExactType<AppScope>();
    assert(s != null, 'AppScope missing');
    return s!.notifier!;
  }
}
