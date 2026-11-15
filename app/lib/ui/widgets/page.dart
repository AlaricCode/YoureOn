import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../tokens.dart';
import 'text.dart';

/// Page scaffold: optional back control and 1–3 word title, page margins,
/// no app-bar chrome.
class AppPage extends StatelessWidget {
  const AppPage({
    super.key,
    this.title,
    required this.child,
    this.back = true,
    this.bottom,
    this.padded = true,
  });

  final String? title;
  final Widget child;
  final bool back;
  final Widget? bottom;
  final bool padded;

  @override
  Widget build(BuildContext context) {
    final canPop = back && Navigator.of(context).canPop();
    return Scaffold(
      backgroundColor: Palette.background,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (canPop || title != null)
              SizedBox(
                height: Space.x6 + Space.x1,
                child: Row(
                  children: [
                    if (canPop)
                      Semantics(
                        button: true,
                        label: 'Back',
                        child: GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTap: () => Navigator.of(context).maybePop(),
                          child: const SizedBox(
                            width: Space.x6,
                            height: Space.x6,
                            child: Icon(LucideIcons.chevronLeft, size: 20, color: Palette.text),
                          ),
                        ),
                      )
                    else
                      const SizedBox(width: Space.page),
                    if (title != null) Expanded(child: Label(title!, style: Typo.heading)),
                  ],
                ),
              ),
            Expanded(
              child: padded
                  ? Padding(padding: const EdgeInsets.symmetric(horizontal: Space.page), child: child)
                  : child,
            ),
            if (bottom != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(Space.page, Space.x1, Space.page, Space.x2),
                child: bottom,
              ),
          ],
        ),
      ),
    );
  }
}
