import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../tokens.dart';
import 'text.dart';

/// Hairline divider (one physical pixel).
class Hairline extends StatelessWidget {
  const Hairline({super.key, this.indent = 0});
  final double indent;

  @override
  Widget build(BuildContext context) {
    final px = 1 / MediaQuery.devicePixelRatioOf(context);
    return Padding(
      padding: EdgeInsets.only(left: indent),
      child: SizedBox(height: px, child: const ColoredBox(color: Palette.hairline)),
    );
  }
}

/// The primary action: the only filled, accent-coloured control.
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({super.key, required this.label, required this.onPressed, this.busy = false});

  final String label;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: enabled ? onPressed : null,
        child: AnimatedOpacity(
          duration: Motion.fast,
          curve: Motion.curve,
          opacity: enabled ? 1 : 0.4,
          child: Container(
            height: Space.control,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: Palette.accent,
              borderRadius: BorderRadius.all(Radius.circular(8)),
            ),
            child: busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 1.5, color: Palette.text),
                  )
                : Label(label, style: Typo.labelStrong),
          ),
        ),
      ),
    );
  }
}

/// A destructive action (delete): red outline by default, red fill when
/// [filled] (the final "Yes, delete" in a confirmation).
class DangerButton extends StatelessWidget {
  const DangerButton({super.key, required this.label, required this.onPressed, this.busy = false, this.filled = false});

  final String label;
  final VoidCallback? onPressed;
  final bool busy;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    final fg = filled ? Palette.text : Palette.danger;
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: enabled ? onPressed : null,
        child: AnimatedOpacity(
          duration: Motion.fast,
          curve: Motion.curve,
          opacity: enabled ? 1 : 0.4,
          child: Container(
            height: Space.control,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: filled ? Palette.danger : null,
              border: filled ? null : Border.all(color: Palette.danger, width: 1),
              borderRadius: const BorderRadius.all(Radius.circular(8)),
            ),
            child: busy
                ? SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 1.5, color: fg),
                  )
                : Label(label, style: Typo.labelStrong.copyWith(color: fg)),
          ),
        ),
      ),
    );
  }
}

/// A secondary action: hairline outline, no fill.
class QuietButton extends StatelessWidget {
  const QuietButton({super.key, required this.label, required this.onPressed, this.busy = false});

  final String label;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: enabled ? onPressed : null,
        child: AnimatedOpacity(
          duration: Motion.fast,
          curve: Motion.curve,
          opacity: enabled ? 1 : 0.4,
          child: Container(
            height: Space.control,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              border: Border.all(color: Palette.hairline, width: 0.5),
              borderRadius: const BorderRadius.all(Radius.circular(8)),
            ),
            child: busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 1.5),
                  )
                : Label(label),
          ),
        ),
      ),
    );
  }
}

/// A list row: label on the left, optional value and chevron on the right.
class ListRow extends StatelessWidget {
  const ListRow({
    super.key,
    required this.label,
    this.value,
    this.trailing,
    this.onTap,
    this.chevron = false,
    this.labelIsData = false,
    this.leading,
  });

  final String label;
  final String? value; // data (amount, state label)
  final Widget? trailing;
  final Widget? leading;
  final VoidCallback? onTap;
  final bool chevron;

  /// True when [label] is data (a bet title or a name), not UI copy.
  final bool labelIsData;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: Space.x6 + Space.x1),
        child: Row(
          children: [
            if (leading != null) ...[leading!, const SizedBox(width: Space.x2)],
            // Copy labels are short: the value takes the remaining width.
            // Data labels (titles, names) take it instead and the value
            // (amount, state) keeps its natural width.
            if (value == null || labelIsData)
              Expanded(child: labelIsData ? DataText(label) : Label(label))
            else
              Label(label),
            if (value != null) ...[
              const SizedBox(width: Space.x2),
              if (labelIsData)
                DataText(value!, style: Typo.value)
              else
                Expanded(child: DataText(value!, style: Typo.value, textAlign: TextAlign.right)),
            ],
            if (trailing != null) ...[const SizedBox(width: Space.x2), trailing!],
            if (chevron) ...[
              const SizedBox(width: Space.x1),
              const Icon(LucideIcons.chevronRight, size: 16, color: Palette.secondary),
            ],
          ],
        ),
      ),
    );
  }
}

/// Small state dot: accent only for live; grey when not applicable.
class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.on, this.live = false, this.placed = true});
  final bool on;
  final bool live;
  final bool placed;

  @override
  Widget build(BuildContext context) {
    final color = !placed
        ? Palette.hairline
        : live
            ? Palette.accent
            : (on ? Palette.text : Palette.secondary.withValues(alpha: 0.35));
    return AnimatedContainer(
      duration: Motion.fast,
      curve: Motion.curve,
      width: 8,
      height: 8,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

/// A selectable chip (hairline outline; selected = text-coloured outline).
class AppChip extends StatelessWidget {
  const AppChip({super.key, required this.label, this.selected = false, this.onTap, this.isData = false});
  final String label;
  final bool selected;
  final VoidCallback? onTap;
  final bool isData;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: onTap != null,
      selected: selected,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: AnimatedContainer(
          duration: Motion.fast,
          curve: Motion.curve,
          height: Space.x4 + Space.x1,
          padding: const EdgeInsets.symmetric(horizontal: Space.x2),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected ? Palette.surface : null,
            border: Border.all(color: selected ? Palette.secondary : Palette.hairline, width: 0.5),
            borderRadius: const BorderRadius.all(Radius.circular(20)),
          ),
          child: isData ? DataText(label) : Label(label),
        ),
      ),
    );
  }
}

/// An error line: a §12.8 message only, never free text.
class ErrorLine extends StatelessWidget {
  const ErrorLine(this.message, {super.key});
  final String? message;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: Motion.fast,
      switchInCurve: Motion.curve,
      child: message == null
          ? const SizedBox(height: Space.x3)
          : SizedBox(
              height: Space.x3,
              child: Center(child: Label(message!, style: Typo.value)),
            ),
    );
  }
}

/// Round capture control for camera and microphone steps.
class ShutterButton extends StatelessWidget {
  const ShutterButton({super.key, required this.onPressed, this.active = false, this.semanticLabel = 'Capture'});
  final VoidCallback? onPressed;
  final bool active;
  final String semanticLabel;

  /// Inner disc: the ring (64) minus its 2 px border and a 4 px gap per side.
  static const double _discSide = Space.x8 - 2 * 2 - Space.x1;

  /// The stop square while recording, well inside the ring.
  static const double _stopSide = 24;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: semanticLabel,
      child: GestureDetector(
        onTap: onPressed,
        child: Container(
          width: Space.x8,
          height: Space.x8,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: Palette.text, width: 2),
          ),
          // Idle: a filled disc inside the ring. Active (recording): a small
          // rounded square centred inside the ring, like a stop button.
          child: AnimatedContainer(
            duration: Motion.fast,
            curve: Motion.curve,
            width: active ? _stopSide : _discSide,
            height: active ? _stopSide : _discSide,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.all(Radius.circular(active ? 5 : _discSide / 2)),
              color: onPressed == null ? Palette.secondary : (active ? Palette.accent : Palette.text),
            ),
          ),
        ),
      ),
    );
  }
}
