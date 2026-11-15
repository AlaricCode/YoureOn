import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../api/models/receipt.dart';
import '../../core/format.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/sheet.dart';
import '../../ui/widgets/text.dart';

/// One key/value row of a Receipt detail sheet. [url] rows open in an
/// external browser (§12.11), except authenticated API URLs (the Terms
/// "Rules file"), which are fetched with the session and shown in-app.
class DetailRow {
  const DetailRow(this.label, this.value, {this.url, this.labelIsData = false});
  final String label;
  final String? value;
  final String? url;
  final bool labelIsData;
}

String _short(String hex) => hex.length <= 12 ? hex : '${hex.substring(0, 6)}…${hex.substring(hex.length - 4)}';
String _yesNo(bool v, String yes, String no) => v ? yes : no;
String _pct(int bps) => '${bps ~/ 100}%';

const Map<String, String> _paths = {'consent': 'Consent', 'rule': 'Rule', 'panel': 'Panel', 'refund': 'Refund'};
const Map<String, String> _modality = {'face': 'Face', 'voice': 'Voice'};

/// The rows of a receipt row's detail sheet (copy keys are 1–3 words; names,
/// hashes and amounts are data).
List<DetailRow> detailRows(ReceiptRow row) {
  final out = <DetailRow>[];
  if (row.url != null) out.add(DetailRow('Explorer', null, url: row.url));
  final d = row.detail;
  switch (d) {
    case VerifiedDetail():
      for (final p in d.participants) {
        final voice = p.voiceCosBps == null ? '' : ' · ${_pct(p.voiceCosBps!)}';
        out.add(DetailRow(p.name, '${_yesNo(p.accepted, 'Accepted', 'Waiting')}$voice', labelIsData: true));
      }
      for (final b in d.bioChecks) {
        out.add(DetailRow(b.participantName, '${_modality[b.modality] ?? b.modality} · ${formatFrames(b.frame)}', labelIsData: true));
      }
      out.add(DetailRow('Cross-check', _yesNo(d.crossCheckOk, 'Passed', 'Failed')));
      out.add(DetailRow('Audio', _yesNo(d.audioDisagree, 'Disagrees', 'Agrees')));
      out.add(DetailRow('Phones', _yesNo(d.phoneDisagree, 'Disagree', 'Agree')));
    case TermsDetail():
      out.add(DetailRow('Program', _short(d.programHash)));
      for (final l in d.readback) {
        out.add(DetailRow(l, null, labelIsData: true));
      }
      out.add(DetailRow('Rules file', null, url: d.yamlUrl));
    case EvidenceDetail():
      out.add(DetailRow('Root', _short(d.evidenceRoot)));
      out.add(DetailRow('Gaps', d.gapMask == 0 ? 'None' : '${_bitCount(d.gapMask)}'));
      for (final w in d.witnesses) {
        final flags = [
          '${w.chunks}',
          if (!w.synced) 'Unsynced',
          if (w.gap) 'Gap',
          if (w.lateChunks > 0) 'Late ${w.lateChunks}',
        ];
        out.add(DetailRow(w.label, flags.join(' · '), labelIsData: true));
      }
    case ComputeDetail():
      for (final h in d.hosts) {
        out.add(DetailRow(h.provider, h.network == 'mock' ? 'Mock' : 'Mainnet', url: h.url, labelIsData: true));
      }
      out.add(DetailRow('Hosts agree', _yesNo(d.agreed, 'Yes', 'No')));
      for (final e in d.entityAgreementBps.entries) {
        out.add(DetailRow(e.key, _pct(e.value), labelIsData: true));
      }
    case ProofDetail():
      for (final b in d.biometric) {
        out.add(DetailRow(
          b.participantName,
          '${_modality[b.modality] ?? b.modality} · ${formatFrames(b.frame)}',
          url: b.txUrl,
          labelIsData: true,
        ));
      }
      out.add(const DetailRow('Binding', 'Trusted'));
      if (d.hasSp1) out.add(DetailRow('Rules proof', d.sp1TxUrl == null ? 'Mock' : null, url: d.sp1TxUrl));
    case SettlementDetail():
      out.add(DetailRow('Path', _paths[d.path] ?? d.path));
      if (d.txUrl != null) out.add(DetailRow('Transaction', null, url: d.txUrl));
      for (final p in d.payouts) {
        out.add(DetailRow(p.name, formatUsd(p.amountUnits), labelIsData: true));
      }
    case UnknownDetail():
    case null:
      break;
  }
  return out;
}

int _bitCount(int v) {
  var n = 0;
  for (var x = v; x != 0; x >>= 1) {
    n += x & 1;
  }
  return n;
}

/// The detail sheet of one receipt row.
class ReceiptDetailSheet extends StatelessWidget {
  const ReceiptDetailSheet({super.key, required this.row, required this.onOpen});
  final ReceiptRow row;
  final ValueChanged<String> onOpen;

  @override
  Widget build(BuildContext context) {
    final rows = detailRows(row);
    return SingleChildScrollView(
      child: RowList(children: [
        for (final r in rows)
          KeyValueRow(
            label: r.label,
            value: r.value,
            labelIsData: r.labelIsData,
            external: r.url != null,
            onTap: r.url == null ? null : () => onOpen(r.url!),
          ),
      ]),
    );
  }
}

/// The bet's `terms.yaml`, fetched in-app (the route needs the bearer
/// token, so it never goes to the external browser).
class RulesFileSheet extends StatelessWidget {
  const RulesFileSheet({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerRight,
          child: AppChip(label: 'Copy', onTap: () => Clipboard.setData(ClipboardData(text: text))),
        ),
        const SizedBox(height: Space.x2),
        Flexible(
          child: SingleChildScrollView(
            key: const ValueKey('rules-file'),
            child: DataText(
              text,
              style: Typo.small.copyWith(fontFamily: 'monospace', fontFamilyFallback: const ['Courier']),
              maxLines: null,
              overflow: TextOverflow.visible,
            ),
          ),
        ),
      ],
    );
  }
}
