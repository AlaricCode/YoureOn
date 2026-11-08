import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../state/app_scope.dart';
import '../../ws/ws_messages.dart';
import '../tokens.dart';
import 'text.dart';

/// Shows WS `notify` titles (≤ 3 words) as a quiet top banner for 3 s
/// ([D-29]: WS + on-device notices only).
class NoticeBanner extends StatefulWidget {
  const NoticeBanner({super.key, required this.child});
  final Widget child;

  @override
  State<NoticeBanner> createState() => _NoticeBannerState();
}

class _NoticeBannerState extends State<NoticeBanner> {
  StreamSubscription<WsNotify>? _sub;
  String? _title;
  Timer? _hide;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sub?.cancel();
    _sub = AppScope.read(context).notices.listen((n) {
      _hide?.cancel();
      setState(() => _title = n.title);
      _hide = Timer(const Duration(seconds: 3), () {
        if (mounted) setState(() => _title = null);
      });
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _hide?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.paddingOf(context).top;
    return Stack(
      children: [
        widget.child,
        Positioned(
          left: Space.page,
          right: Space.page,
          top: top + Space.x1,
          child: IgnorePointer(
            child: AnimatedOpacity(
              duration: Motion.fast,
              curve: Motion.curve,
              opacity: _title == null ? 0 : 1,
              child: Container(
                height: Space.x5,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: Palette.surface,
                  border: Border.all(color: Palette.hairline, width: 0.5),
                  borderRadius: const BorderRadius.all(Radius.circular(8)),
                ),
                child: _title == null ? const SizedBox.shrink() : Label(_title!),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
