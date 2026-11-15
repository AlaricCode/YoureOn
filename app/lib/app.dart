import 'dart:async';

import 'package:flutter/material.dart';

import 'nav/screen_table.dart';
import 'screens/enroll_screen.dart';
import 'screens/home_screen.dart';
import 'screens/restoring_screen.dart';
import 'screens/sign_in_screen.dart';
import 'state/app_controller.dart';
import 'state/app_scope.dart';
import 'ui/theme.dart';
import 'ui/tokens.dart';
import 'ui/widgets/notice_banner.dart';

/// Root widget.
class VerdictApp extends StatelessWidget {
  const VerdictApp({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      controller: controller,
      child: MaterialApp(
        title: 'Verdict',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(),
        darkTheme: buildTheme(),
        themeMode: ThemeMode.dark,
        onGenerateRoute: onGenerateRoute,
        builder: (context, child) => NoticeBanner(child: child ?? const SizedBox.shrink()),
        home: const RootGate(),
      ),
    );
  }
}

/// Sign in → Enroll (if not enrolled) → Home (CONTRACTS.md §12.13).
class RootGate extends StatefulWidget {
  const RootGate({super.key});

  @override
  State<RootGate> createState() => _RootGateState();
}

class _RootGateState extends State<RootGate> {
  bool? _wasSignedIn;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final app = AppScope.of(context);
    final signedIn = app.signedIn;
    // On sign-out, drop every pushed screen.
    if (_wasSignedIn == true && !signedIn) {
      scheduleMicrotask(() {
        if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
      });
    }
    _wasSignedIn = signedIn;
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final Widget page;
    if (!app.ready) {
      page = const ColoredBox(key: ValueKey('boot'), color: Palette.background, child: SizedBox.expand());
    } else if (app.restoring) {
      page = const RestoringScreen(key: ValueKey('restoring'));
    } else if (!app.signedIn) {
      page = const SignInScreen(key: ValueKey('signin'));
    } else if (!app.user!.enrolled) {
      page = const EnrollScreen(key: ValueKey('enroll'));
    } else {
      page = const HomeScreen(key: ValueKey('home'));
    }
    return AnimatedSwitcher(duration: Motion.fast, switchInCurve: Motion.curve, child: page);
  }
}
