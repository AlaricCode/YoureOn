import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/ui/widgets/text.dart';

/// Copy rule (spec §6.3, CONTRACTS.md §12.12), checked on whatever is on
/// screen:
/// 1. UI copy (any Text not inside a [DataText]) is 1–3 words.
/// 2. No Text in a smaller style sits directly below a label (no subtitles,
///    helper text or captions).
/// 3. No emoji anywhere.
void expectCopyRule(WidgetTester tester, {String screen = ''}) {
  final texts = <_T>[];
  for (final e in find.byType(Text, skipOffstage: true).evaluate()) {
    final w = e.widget as Text;
    final s = w.data ?? w.textSpan?.toPlainText() ?? '';
    if (s.trim().isEmpty) continue;
    final ro = e.renderObject;
    if (ro is! RenderBox || !ro.hasSize || !ro.attached) continue;
    final isData = e.findAncestorWidgetOfExactType<DataText>() != null;
    final style = DefaultTextStyle.of(e).style.merge(w.style);
    final tl = ro.localToGlobal(Offset.zero);
    texts.add(_T(s, isData, style.fontSize ?? 14, tl & ro.size));
  }

  final emoji = RegExp(r'[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}]', unicode: true);
  for (final t in texts) {
    expect(emoji.hasMatch(t.text), isFalse, reason: '$screen: emoji in "${t.text}"');
    if (!t.isData) {
      final words = t.text.trim().split(RegExp(r'\s+'));
      expect(words.length, lessThanOrEqualTo(3), reason: '$screen: label longer than 3 words: "${t.text}"');
      expect(t.text.trim().endsWith('.'), isFalse, reason: '$screen: sentence copy: "${t.text}"');
    }
  }

  for (final a in texts.where((t) => !t.isData)) {
    for (final b in texts) {
      if (identical(a, b)) continue;
      final below = b.rect.top >= a.rect.bottom - 1 && b.rect.top - a.rect.bottom <= 16;
      final overlap = _hOverlap(a.rect, b.rect) > 0.5 * (b.rect.width < a.rect.width ? b.rect.width : a.rect.width);
      if (below && overlap && b.fontSize < a.fontSize) {
        fail('$screen: "${b.text}" is a smaller text directly below the label "${a.text}"');
      }
    }
  }
}

double _hOverlap(Rect a, Rect b) {
  final l = a.left > b.left ? a.left : b.left;
  final r = a.right < b.right ? a.right : b.right;
  return r > l ? r - l : 0;
}

class _T {
  _T(this.text, this.isData, this.fontSize, this.rect);
  final String text;
  final bool isData;
  final double fontSize;
  final Rect rect;
}
