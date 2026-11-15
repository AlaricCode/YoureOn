import 'package:flutter/animation.dart';
import 'package:flutter/painting.dart';

/// Design tokens (CONTRACTS.md §12.12, spec §6.2).
abstract final class Palette {
  static const Color background = Color(0xFF0B0B0C);
  static const Color surface = Color(0xFF141416);
  static const Color hairline = Color(0xFF26262A);
  static const Color text = Color(0xFFEDEDEF);
  static const Color secondary = Color(0xFF8A8A8F);

  /// The only accent: primary action and the live dot.
  static const Color accent = Color(0xFF5E6AD2);
}

/// 8-pt grid.
abstract final class Space {
  static const double unit = 8;
  static const double x1 = 8;
  static const double x2 = 16;
  static const double x3 = 24;
  static const double x4 = 32;
  static const double x5 = 40;
  static const double x6 = 48;
  static const double x8 = 64;

  /// Horizontal page margin.
  static const double page = 24;

  /// Standard control height.
  static const double control = 48;
}

/// Inter, weights 400/600, scale 13/15/17/22/28.
abstract final class Typo {
  static const String family = 'Inter';
  static const FontWeight regular = FontWeight.w400;
  static const FontWeight semibold = FontWeight.w600;

  static const TextStyle display = TextStyle(
    fontFamily: family, fontSize: 28, height: 36 / 28, fontWeight: semibold, color: Palette.text, letterSpacing: -0.4);
  static const TextStyle title = TextStyle(
    fontFamily: family, fontSize: 22, height: 32 / 22, fontWeight: semibold, color: Palette.text, letterSpacing: -0.2);
  static const TextStyle heading = TextStyle(
    fontFamily: family, fontSize: 17, height: 24 / 17, fontWeight: semibold, color: Palette.text);
  static const TextStyle label = TextStyle(
    fontFamily: family, fontSize: 15, height: 24 / 15, fontWeight: regular, color: Palette.text);
  static const TextStyle labelStrong = TextStyle(
    fontFamily: family, fontSize: 15, height: 24 / 15, fontWeight: semibold, color: Palette.text);
  static const TextStyle value = TextStyle(
    fontFamily: family, fontSize: 15, height: 24 / 15, fontWeight: regular, color: Palette.secondary);
  static const TextStyle small = TextStyle(
    fontFamily: family, fontSize: 13, height: 16 / 13, fontWeight: regular, color: Palette.secondary);

  static const List<double> scale = [13, 15, 17, 22, 28];
}

/// Motion: functional only, 150 ms easeOut, no springs.
abstract final class Motion {
  static const Duration fast = Duration(milliseconds: 150);
  static const Curve curve = Curves.easeOut;
}
