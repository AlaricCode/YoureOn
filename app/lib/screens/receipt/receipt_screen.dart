import 'dart:convert';

import 'package:flutter/material.dart';


import '../../api/models/receipt.dart';
import '../../nav/routes.dart';
import '../../state/guarded.dart';
import '../../state/ws_watch.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/page.dart';
import '../../ui/widgets/sheet.dart';
import '../../ws/ws_messages.dart';
import 'receipt_detail.dart';

/// Receipt (spec §6.5, CONTRACTS.md §12.11): Verified · Terms · Evidence ·
/// Compute · Proof · Settlement, each a link row opening a detail sheet.
class ReceiptScreen extends StatefulWidget {
  const ReceiptScreen({super.key, required this.args});
  final BetArgs args;

  @override
  State<ReceiptScreen> createState() => _ReceiptScreenState();
}

class _ReceiptScreenState extends State<ReceiptScreen> with Guarded, WsWatch {
  List<ReceiptRow> _rows = const [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      watchWs([Topics.bet(widget.args.betId)], _onWs);
      _load();
    });
  }

  Future<void> _load() => guard('load', () async {
        final rows = await app.api.receipt(widget.args.betId);
        if (mounted) setState(() => _rows = rows);
      });

  void _onWs(WsMessage m) {
    // Settlement and proofs land after the ruling: refresh on any update.
    if (m is WsBet && m.bet.id == widget.args.betId) _load();
  }

  /// API URLs (relative, or absolute under `/v1/`) need the bearer token:
  /// fetch them in-app. Only other absolute URLs (explorer, tx links) go to
  /// the external browser.
  static bool _isApiUrl(String url) {
    final u = Uri.parse(url);
    return !u.hasScheme || u.path.startsWith('/v1/');
  }

  Future<void> _open(String url) async {
    if (_isApiUrl(url)) {
      await _viewFile(url);
      return;
    }
    await app.openLink(Uri.parse(url));
  }

  Future<void> _viewFile(String url) => guard('file', () async {
        // A missing file surfaces as NOT_FOUND ("Not found") in the error line.
        final text = utf8.decode(await app.transport.getBytes(url), allowMalformed: true);
        if (!mounted) return;
        await showAppSheet<void>(context, (_) => RulesFileSheet(text: text));
      }, exclusive: false);

  void _detail(ReceiptRow row) =>
      showAppSheet<void>(context, (_) => ReceiptDetailSheet(row: row, onOpen: _open));

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: 'Receipt',
      child: ListView(children: [
        const SizedBox(height: Space.x2),
        RowList(children: [
          for (final r in _rows)
            ListRow(
              key: ValueKey('receipt-${r.key}'),
              label: r.label,
              value: _status(r.status),
              trailing: StatusDot(on: r.status == RowStatus.ok, placed: r.status != RowStatus.none),
              chevron: true,
              onTap: () => _detail(r),
            ),
        ]),
        if (_rows.isNotEmpty) const Hairline(),
        ErrorLine(error),
      ]),
    );
  }

  static String? _status(RowStatus s) => switch (s) {
        RowStatus.ok => null,
        RowStatus.pending => 'Pending',
        RowStatus.failed => 'Failed',
        RowStatus.none => 'None',
      };
}

