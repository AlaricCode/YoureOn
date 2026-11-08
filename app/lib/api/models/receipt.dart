import 'json.dart';

enum RowStatus {
  ok('ok'),
  pending('pending'),
  failed('failed'),
  none('none');

  const RowStatus(this.wire);
  final String wire;
}

/// Receipt detail variants (CONTRACTS.md §12.11).
sealed class ReceiptDetail {
  const ReceiptDetail();

  factory ReceiptDetail.fromJson(Object? v) {
    final j = asJson(v, 'detail');
    switch (asString(j['key'])) {
      case 'verified':
        return VerifiedDetail.fromJson(j);
      case 'terms':
        return TermsDetail.fromJson(j);
      case 'evidence':
        return EvidenceDetail.fromJson(j);
      case 'compute':
        return ComputeDetail.fromJson(j);
      case 'proof':
        return ProofDetail.fromJson(j);
      case 'settlement':
        return SettlementDetail.fromJson(j);
      default:
        return UnknownDetail(j);
    }
  }
}

class UnknownDetail extends ReceiptDetail {
  const UnknownDetail(this.json);
  final Json json;
}

class VerifiedParticipant {
  const VerifiedParticipant({required this.name, required this.accepted, this.voiceCosBps});
  final String name;
  final bool accepted;
  final int? voiceCosBps;
}

class BioCheck {
  const BioCheck({required this.participantName, required this.frame, required this.modality});
  final String participantName;
  final int frame;
  final String modality; // face | voice
}

class VerifiedDetail extends ReceiptDetail {
  const VerifiedDetail({
    required this.participants,
    required this.bioChecks,
    required this.crossCheckOk,
    required this.audioDisagree,
    required this.phoneDisagree,
  });

  final List<VerifiedParticipant> participants;
  final List<BioCheck> bioChecks;
  final bool crossCheckOk;
  final bool audioDisagree;
  final bool phoneDisagree;

  factory VerifiedDetail.fromJson(Json j) => VerifiedDetail(
        participants: asList(j['participants'], (e) {
          final p = asJson(e);
          return VerifiedParticipant(
            name: asString(p['name']),
            accepted: asBool(p['accepted']),
            voiceCosBps: asIntOrNull(p['voice_cos_bps']),
          );
        }),
        bioChecks: asList(j['bio_checks'], (e) {
          final b = asJson(e);
          return BioCheck(
            participantName: asString(b['participant_name']),
            frame: asInt(b['frame']),
            modality: asString(b['modality']),
          );
        }),
        crossCheckOk: asBool(j['cross_check_ok']),
        audioDisagree: asBool(j['audio_disagree']),
        phoneDisagree: asBool(j['phone_disagree']),
      );
}

class TermsDetail extends ReceiptDetail {
  const TermsDetail({required this.programHash, required this.readback, required this.yamlUrl});
  final String programHash;
  final List<String> readback;
  final String yamlUrl;

  factory TermsDetail.fromJson(Json j) => TermsDetail(
        programHash: asString(j['program_hash']),
        readback: asStringList(j['readback']),
        yamlUrl: asString(j['yaml_url']),
      );
}

class EvidenceWitness {
  const EvidenceWitness({
    required this.label,
    required this.chunks,
    required this.synced,
    required this.gap,
    required this.lateChunks,
    required this.gapsMs,
  });
  final String label;
  final int chunks;
  final bool synced;
  final bool gap;
  final int lateChunks;
  final List<int> gapsMs;
}

class EvidenceDetail extends ReceiptDetail {
  const EvidenceDetail({required this.evidenceRoot, required this.gapMask, required this.witnesses});
  final String evidenceRoot;
  final int gapMask;
  final List<EvidenceWitness> witnesses;

  factory EvidenceDetail.fromJson(Json j) => EvidenceDetail(
        evidenceRoot: asString(j['evidence_root']),
        gapMask: asInt(j['gap_mask']),
        witnesses: asList(j['witnesses'], (e) {
          final w = asJson(e);
          return EvidenceWitness(
            label: asString(w['label']),
            chunks: asInt(w['chunks']),
            synced: asBool(w['synced']),
            gap: asBool(w['gap']),
            lateChunks: asInt(w['late_chunks']),
            gapsMs: asIntList(w['gaps_ms']),
          );
        }),
      );
}

class ComputeHost {
  const ComputeHost({
    required this.provider,
    required this.jobId,
    required this.url,
    required this.network,
    required this.modelHash,
  });
  final String provider;
  final String jobId;
  final String? url;
  final String network; // mainnet | mock
  final String modelHash;
}

class ComputeDetail extends ReceiptDetail {
  const ComputeDetail({required this.hosts, required this.agreed, required this.entityAgreementBps});
  final List<ComputeHost> hosts;
  final bool agreed;
  final Map<String, int> entityAgreementBps;

  factory ComputeDetail.fromJson(Json j) => ComputeDetail(
        hosts: asList(j['hosts'], (e) {
          final h = asJson(e);
          return ComputeHost(
            provider: asString(h['provider']),
            jobId: asString(h['job_id']),
            url: asStringOrNull(h['url']),
            network: asString(h['network']),
            modelHash: asString(h['model_hash']),
          );
        }),
        agreed: asBool(j['agreed']),
        entityAgreementBps: asIntMap(j['entity_agreement_bps']),
      );
}

class BiometricProof {
  const BiometricProof({required this.participantName, required this.modality, required this.frame, this.txUrl});
  final String participantName;
  final String modality;
  final int frame;
  final String? txUrl;
}

class ProofDetail extends ReceiptDetail {
  const ProofDetail({required this.biometric, required this.binding, this.sp1TxUrl, required this.hasSp1});
  final List<BiometricProof> biometric;
  final String binding; // always "trusted"
  final bool hasSp1;
  final String? sp1TxUrl;

  factory ProofDetail.fromJson(Json j) {
    final sp1 = j['sp1'] == null ? null : asJson(j['sp1']);
    return ProofDetail(
      biometric: asList(j['biometric'], (e) {
        final b = asJson(e);
        return BiometricProof(
          participantName: asString(b['participant_name']),
          modality: asString(b['modality']),
          frame: asInt(b['frame']),
          txUrl: asStringOrNull(b['tx_url']),
        );
      }),
      binding: asString(j['binding']),
      hasSp1: sp1 != null,
      sp1TxUrl: sp1 == null ? null : asStringOrNull(sp1['tx_url']),
    );
  }
}

class NamedPayout {
  const NamedPayout({required this.name, required this.amountUnits});
  final String name;
  final int amountUnits;
}

class SettlementDetail extends ReceiptDetail {
  const SettlementDetail({required this.path, required this.txUrl, required this.payouts});
  final String path;
  final String? txUrl;
  final List<NamedPayout> payouts;

  factory SettlementDetail.fromJson(Json j) => SettlementDetail(
        path: asString(j['path']),
        txUrl: asStringOrNull(j['tx_url']),
        payouts: asList(j['payouts'], (e) {
          final p = asJson(e);
          return NamedPayout(name: asString(p['name']), amountUnits: asInt(p['amount_units']));
        }),
      );
}

/// `ReceiptRow` (§12.11). Labels: Verified, Terms, Evidence, Compute, Proof,
/// Settlement.
class ReceiptRow {
  const ReceiptRow({
    required this.key,
    required this.label,
    required this.status,
    required this.url,
    required this.detail,
  });

  final String key;
  final String label;
  final RowStatus status;
  final String? url; // null in mock mode
  final ReceiptDetail? detail;

  factory ReceiptRow.fromJson(Object? v) {
    final j = asJson(v, 'ReceiptRow');
    return ReceiptRow(
      key: asString(j['key']),
      label: asString(j['label']),
      status: enumByWire(RowStatus.values, j['status'], (e) => e.wire),
      url: asStringOrNull(j['url']),
      detail: j['detail'] == null ? null : ReceiptDetail.fromJson(j['detail']),
    );
  }
}
