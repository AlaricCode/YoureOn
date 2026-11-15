import '../contracts/constants.dart';

/// Money display (CONTRACTS.md §12.9): `$` + floor(units / 10_000) / 100,
/// exactly two decimals, thousands separators. Never token names.
String formatUsd(int units) {
  if (units < 0) throw ArgumentError('use formatSignedUsd for negatives');
  final cents = units ~/ 10000;
  final dollars = cents ~/ 100;
  final rem = cents % 100;
  return '\$${_groupThousands(dollars)}.${rem.toString().padLeft(2, '0')}';
}

/// "+$5.00" / "−$5.00" (U+2212 minus); zero renders unsigned.
String formatSignedUsd(int units) {
  if (units > 0) return '+${formatUsd(units)}';
  if (units < 0) return '−${formatUsd(-units)}';
  return formatUsd(0);
}

String _groupThousands(int n) {
  final s = n.toString();
  final sb = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) sb.write(',');
    sb.write(s[i]);
  }
  return sb.toString();
}

/// Parses a typed dollar amount ("5", "5.5", "$1,234.50") into USDC base
/// units. Returns null for anything that is not a non-negative amount with at
/// most 2 decimals.
int? parseUsd(String input) {
  final s = input.trim().replaceAll(',', '').replaceFirst(RegExp(r'^\$'), '');
  final m = RegExp(r'^(\d{1,9})(?:\.(\d{0,2}))?$').firstMatch(s);
  if (m == null) return null;
  final whole = int.parse(m.group(1)!);
  final frac = (m.group(2) ?? '').padRight(2, '0');
  final cents = whole * 100 + (frac.isEmpty ? 0 : int.parse(frac));
  return cents * 10000;
}

/// Duration rendering (§2.8) from engine frames: "{n}s" (one decimal when
/// frames % 10 != 0), or "{m}m {s}s" / "{m}m" for whole seconds >= 60.
String formatFrames(int frames) {
  if (frames < 0) throw ArgumentError('negative duration');
  if (frames % FPS != 0) {
    final whole = frames ~/ FPS;
    final tenth = frames % FPS;
    return '$whole.${tenth}s';
  }
  final secs = frames ~/ FPS;
  if (secs < 60) return '${secs}s';
  final m = secs ~/ 60;
  final s = secs % 60;
  return s == 0 ? '${m}m' : '${m}m ${s}s';
}

/// Seconds → §2.8 duration text.
String formatSeconds(int seconds) => formatFrames(seconds * FPS);

/// Record timer: "m:ss" for a millisecond count (clamped at zero).
String formatClock(int ms) {
  final total = ms < 0 ? 0 : ms ~/ 1000;
  final m = total ~/ 60;
  final s = total % 60;
  return '$m:${s.toString().padLeft(2, '0')}';
}
