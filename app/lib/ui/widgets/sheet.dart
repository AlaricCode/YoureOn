import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../tokens.dart';
import 'controls.dart';
import 'text.dart';

/// Opens a bottom sheet on the surface colour with page margins.
Future<T?> showAppSheet<T>(BuildContext context, WidgetBuilder builder) => showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (c) => SheetBody(child: builder(c)),
    );

class SheetBody extends StatelessWidget {
  const SheetBody({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final inset = MediaQuery.viewInsetsOf(context).bottom;
    final maxH = MediaQuery.sizeOf(context).height * 0.85;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxH),
      child: Padding(
        padding: EdgeInsets.fromLTRB(Space.page, Space.x3, Space.page, Space.x3 + inset),
        child: child,
      ),
    );
  }
}

/// A key/value row: 1–3 word key (copy) and a data value. Rows with
/// [onTap] show a chevron; [external] marks a link that leaves the app.
class KeyValueRow extends StatelessWidget {
  const KeyValueRow({
    super.key,
    required this.label,
    this.value,
    this.onTap,
    this.external = false,
    this.labelIsData = false,
    this.trailing,
  });

  final String label;
  final String? value;
  final VoidCallback? onTap;
  final bool external;
  final bool labelIsData;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return ListRow(
      label: label,
      labelIsData: labelIsData,
      value: value,
      onTap: onTap,
      chevron: onTap != null && !external,
      trailing: trailing ??
          (external && onTap != null
              ? const Icon(LucideIcons.externalLink, size: 16, color: Palette.secondary)
              : null),
    );
  }
}

/// A list of rows separated by hairlines.
class RowList extends StatelessWidget {
  const RowList({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0) const Hairline(),
          children[i],
        ],
      ],
    );
  }
}

/// A short secondary section heading (1–3 words).
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: Space.x2, bottom: Space.x1),
        child: Label(text, style: Typo.value),
      );
}

/// A small outlined tag ("AI-judged", "Trusted", "Parlay").
class Tag extends StatelessWidget {
  const Tag(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Container(
        height: Space.x3,
        padding: const EdgeInsets.symmetric(horizontal: Space.x1),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          border: Border.all(color: Palette.hairline, width: 0.5),
          borderRadius: const BorderRadius.all(Radius.circular(4)),
        ),
        child: Label(text, style: Typo.value),
      );
}
