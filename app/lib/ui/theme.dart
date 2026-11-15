import 'package:flutter/material.dart';

import 'tokens.dart';

/// Fades between pages in 150 ms, easeOut. No slides, no springs.
class FadePageTransitionsBuilder extends PageTransitionsBuilder {
  const FadePageTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) =>
      FadeTransition(opacity: CurvedAnimation(parent: animation, curve: Motion.curve), child: child);
}

/// The single monochrome dark theme (CONTRACTS.md §12.12).
ThemeData buildTheme() {
  const scheme = ColorScheme.dark(
    primary: Palette.accent,
    onPrimary: Palette.text,
    secondary: Palette.text,
    onSecondary: Palette.background,
    surface: Palette.surface,
    onSurface: Palette.text,
    error: Palette.text,
    onError: Palette.background,
    outline: Palette.hairline,
    outlineVariant: Palette.hairline,
  );

  const textTheme = TextTheme(
    displaySmall: Typo.display,
    headlineSmall: Typo.title,
    titleMedium: Typo.heading,
    bodyMedium: Typo.label,
    bodyLarge: Typo.label,
    labelLarge: Typo.labelStrong,
    bodySmall: Typo.small,
    labelSmall: Typo.small,
  );

  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    fontFamily: Typo.family,
    textTheme: textTheme,
    scaffoldBackgroundColor: Palette.background,
    canvasColor: Palette.background,
    dividerColor: Palette.hairline,
    splashFactory: NoSplash.splashFactory,
    highlightColor: Colors.transparent,
    splashColor: Colors.transparent,
    hoverColor: Colors.transparent,
    dividerTheme: const DividerThemeData(color: Palette.hairline, thickness: 0.5, space: 0.5),
    appBarTheme: const AppBarTheme(
      backgroundColor: Palette.background,
      foregroundColor: Palette.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: Typo.heading,
    ),
    inputDecorationTheme: const InputDecorationTheme(
      filled: true,
      fillColor: Palette.surface,
      hintStyle: Typo.value,
      contentPadding: EdgeInsets.symmetric(horizontal: Space.x2, vertical: Space.x2),
      border: OutlineInputBorder(borderSide: BorderSide(color: Palette.hairline, width: 0.5), borderRadius: BorderRadius.all(Radius.circular(8))),
      enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Palette.hairline, width: 0.5), borderRadius: BorderRadius.all(Radius.circular(8))),
      focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: Palette.secondary, width: 0.5), borderRadius: BorderRadius.all(Radius.circular(8))),
    ),
    textSelectionTheme: const TextSelectionThemeData(cursorColor: Palette.text, selectionColor: Palette.hairline),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? Palette.text : Palette.secondary),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? Palette.hairline : Palette.surface),
      trackOutlineColor: const WidgetStatePropertyAll(Palette.hairline),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: Palette.secondary),
    pageTransitionsTheme: const PageTransitionsTheme(builders: {
      TargetPlatform.android: FadePageTransitionsBuilder(),
      TargetPlatform.iOS: FadePageTransitionsBuilder(),
      TargetPlatform.linux: FadePageTransitionsBuilder(),
      TargetPlatform.macOS: FadePageTransitionsBuilder(),
      TargetPlatform.windows: FadePageTransitionsBuilder(),
      TargetPlatform.fuchsia: FadePageTransitionsBuilder(),
    }),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: Palette.surface,
      modalBackgroundColor: Palette.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(12))),
    ),
  );
}
