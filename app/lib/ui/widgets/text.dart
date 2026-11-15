import 'package:flutter/widgets.dart';

import '../tokens.dart';

/// Marks user/server data (names, titles, amounts, codes, phrases to read
/// aloud) as opposed to UI copy. Copy is limited to 1–3 word labels
/// (spec §6.3); data is exempt from the word limit. The copy-rule test
/// (test/copy_rule_test.dart) relies on this marker.
class DataText extends StatelessWidget {
  const DataText(
    this.data, {
    super.key,
    this.style = Typo.label,
    this.maxLines = 1,
    this.textAlign,
    this.overflow = TextOverflow.ellipsis,
  });

  final String data;
  final TextStyle style;
  final int? maxLines;
  final TextAlign? textAlign;
  final TextOverflow overflow;

  @override
  Widget build(BuildContext context) =>
      Text(data, style: style, maxLines: maxLines, overflow: overflow, textAlign: textAlign);
}

/// A 1–3 word UI label.
class Label extends StatelessWidget {
  const Label(this.text, {super.key, this.style = Typo.label, this.textAlign});
  final String text;
  final TextStyle style;
  final TextAlign? textAlign;

  @override
  Widget build(BuildContext context) =>
      Text(text, style: style, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: textAlign);
}
