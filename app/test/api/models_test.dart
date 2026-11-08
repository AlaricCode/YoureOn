import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/models/bet.dart';
import 'package:verdict/api/models/calibration.dart';
import 'package:verdict/api/models/draft.dart';
import 'package:verdict/api/models/huddle.dart';
import 'package:verdict/api/models/program.dart';
import 'package:verdict/api/models/receipt.dart';
import 'package:verdict/api/models/ruling.dart';
import 'package:verdict/api/models/sign.dart';
import 'package:verdict/api/models/user.dart';
import 'package:verdict/api/models/world.dart';
import 'package:verdict/core/state_labels.dart';
import 'package:verdict/ws/ws_messages.dart';

import '../support/fixtures.dart';

void main() {
  test('UserView', () {
    final u = UserView.fromJson(userJson(face: true, voice: false));
    expect(u.displayName, 'Ana');
    expect(u.enrolled, isFalse);
    expect(UserView.fromJson(u.toJson()).voiceEnrolled, isFalse);
  });

  test('BetView parses every §12.2 field', () {
    final b = BetView.fromJson(betJson());
    expect(b.state, BetState.preruled);
    expect(b.kind, ProgramKind.rules);
    expect(b.participants[1].consent, Consent.agree);
    expect(b.myStakeUnits, 5000000);
    expect(b.isParticipant, isTrue);
    expect(b.program.entities.length, 4);
    expect(b.program.regions.single.isLine, isTrue);
    expect(b.program.legs.single['id'], 1);
    expect(b.calibration!.regions.single.behindSign, 1);
    expect(b.calibration!.camera.widthPx, 1920);
    expect(b.conditions.single.key, '0/success/');
    expect(b.deadlines.consent, 1700000120000);
    expect(b.deadlines.fund, isNull);
    expect(b.witnesses[1].synced, isNull);
    expect(b.preruling!.winnerMask, 2);
    expect(b.settlement, isNull);
  });

  test('state labels (§12.9)', () {
    expect(stateLabel(BetState.proposed), 'Waiting');
    expect(stateLabel(BetState.funded), 'Ready');
    expect(stateLabel(BetState.live), 'Live');
    expect(stateLabel(BetState.perceiving), 'Reviewing');
    expect(stateLabel(BetState.preruled), 'Ruled');
    expect(stateLabel(BetState.disputed), 'Replay booth');
    expect(stateLabel(BetState.settled), 'Settled');
    expect(stateLabel(BetState.refunded), 'Refunded');
    Map<String, dynamic> settled(int mask) =>
        {'path': 'consent', 'winner_mask': mask, 'payouts': [], 'tx_signature': 'x'};
    expect(betStateLabel(BetView.fromJson(betJson(state: 'settled', myIndex: 1, settlement: settled(2)))), 'Won');
    expect(betStateLabel(BetView.fromJson(betJson(state: 'settled', myIndex: 0, settlement: settled(2)))), 'Lost');
    final bystander = betJson(state: 'settled', settlement: settled(2))
      ..['my_role'] = 'bystander'
      ..['my_index'] = null;
    expect(betStateLabel(BetView.fromJson(bystander)), 'Settled');
  });

  test('DraftView', () {
    final d = DraftView.fromJson(draftJson());
    expect(d.status, DraftStatus.needsClarification);
    expect(d.questions.first.kind, QuestionKind.region);
    expect(d.questions[1].chips, [r'$1', r'$5', r'$10']);
    expect(d.program, isNull);
    expect(d.warnings.single.code, 'UNUSED_ENTITY');
    expect(d.allCounterpartiesAccepted, isTrue);
  });

  test('Calibration round trip omits absent optionals', () {
    final c = Calibration.fromJson(betJson()['calibration']);
    final j = c.toJson();
    expect(j['version'], 1);
    expect((j['scene'] as Map)['camera'], {'width_px': 1920, 'height_px': 1080, 'orientation': 'landscape'});
    expect(((j['scene'] as Map)['entity_refs'] as List).single.containsKey('crop_sha256'), isFalse);
    expect(Calibration.fromJson(j).toJson(), j);
  });

  test('region validity and line side (§3.3, §5.2)', () {
    expect(lineSide([3000, 6000], [3000, 10000], [1000, 9000]), 1); // §15.1 worked example
    expect(lineSide([3000, 6000], [3000, 10000], [5000, 9000]), -1);
    expect(lineSide([3000, 6000], [3000, 10000], [3000, 7000]), 0);
    expect(const Region.line(entity: 'l', points: [[0, 0], [0, 0]], behindSign: 1).valid, isFalse);
    expect(const Region.line(entity: 'l', points: [[0, 0], [10, 0]], behindSign: 1).valid, isTrue);
    expect(const Region.zone(entity: 'z', points: [[0, 0], [10, 0]]).valid, isFalse);
    expect(const Region.zone(entity: 'z', points: [[0, 0], [10, 0], [10, 10001]]).valid, isFalse);
    expect(const Region.zone(entity: 'z', points: [[0, 0], [10, 0], [10, 10]]).valid, isTrue);
  });

  test('SignRequest and TxResult (§12.1)', () {
    final s = SignRequest.fromJson({'tx_id': 't', 'message_b64': 'AA==', 'expires_at_ms': 10, 'summary': r'Stake $5.00'});
    expect(s.expiredAt(9), isFalse);
    expect(s.expiredAt(10), isTrue);
    final ok = TxResult.fromJson({'status': 'confirmed', 'signature': 'sig', 'error': null});
    expect(ok.confirmed, isTrue);
    final bad = TxResult.fromJson({
      'status': 'failed',
      'signature': null,
      'error': {'code': 'INSUFFICIENT_FUNDS', 'message': 'x'},
    });
    expect(bad.errorCode, 'INSUFFICIENT_FUNDS');
  });

  test('HuddleView', () {
    final h = HuddleView.fromJson({
      'id': 'h1',
      'code': '123456',
      'creator_user_id': 'u1',
      'members': [
        {'user': userJson(), 'joined_at_ms': 1, 'confirmed': true},
        {'user': userJson(id: 'u2', name: 'Ben'), 'joined_at_ms': 2, 'confirmed': false},
      ],
    });
    expect(h.confirmed.single.user.id, 'u1');
  });

  test('Ruling and receipt rows (§12.10, §12.11)', () {
    final r = RulingView.fromJson({
      'outcome_text': 'You win',
      'preruling': 1,
      'readback': ['a'],
      'legs': [
        {'id': 1, 'result': 1, 'decisive_frames': [41, 58]},
      ],
      'amount_units': -5000000,
      'can_respond': true,
      'bond_units': 1000000,
    });
    expect(r.legs.single.decisiveFrames, [41, 58]);
    expect(r.amountUnits, -5000000);
    expect(kDisputeReasons[3], 'Bad tracking');

    final rows = [
      {
        'key': 'verified',
        'label': 'Verified',
        'status': 'ok',
        'url': null,
        'detail': {
          'key': 'verified',
          'participants': [
            {'name': 'Ana', 'accepted': true, 'voice_cos_bps': null},
          ],
          'bio_checks': [
            {'participant_name': 'Ben', 'frame': 41, 'modality': 'face'},
          ],
          'cross_check_ok': true,
          'audio_disagree': false,
          'phone_disagree': false,
        },
      },
      {
        'key': 'evidence',
        'label': 'Evidence',
        'status': 'pending',
        'url': null,
        'detail': {
          'key': 'evidence',
          'evidence_root': '00' * 32,
          'gap_mask': 0,
          'witnesses': [
            {'label': 'Camera 1', 'chunks': 25, 'synced': true, 'gap': false, 'late_chunks': 0, 'gaps_ms': [120]},
          ],
        },
      },
      {
        'key': 'compute',
        'label': 'Compute',
        'status': 'ok',
        'url': null,
        'detail': {
          'key': 'compute',
          'hosts': [
            {'provider': 'mock', 'job_id': 'j', 'url': null, 'network': 'mock', 'model_hash': 'ff' * 32},
          ],
          'agreed': true,
          'entity_agreement_bps': {'ball': 9800},
        },
      },
      {
        'key': 'proof',
        'label': 'Proof',
        'status': 'ok',
        'url': null,
        'detail': {'key': 'proof', 'biometric': [], 'binding': 'trusted', 'sp1': null},
      },
      {
        'key': 'settlement',
        'label': 'Settlement',
        'status': 'none',
        'url': null,
        'detail': {
          'key': 'settlement',
          'path': 'consent',
          'tx_url': null,
          'payouts': [
            {'name': 'Ben', 'amount_units': 10000000},
          ],
        },
      },
      {
        'key': 'terms',
        'label': 'Terms',
        'status': 'ok',
        'url': null,
        'detail': {'key': 'terms', 'program_hash': 'ab' * 32, 'readback': ['x'], 'yaml_url': '/v1/x.yaml'},
      },
    ].map(ReceiptRow.fromJson).toList();
    expect(rows[0].detail, isA<VerifiedDetail>());
    expect((rows[1].detail as EvidenceDetail).witnesses.single.gapsMs, [120]);
    expect(rows[1].status, RowStatus.pending);
    expect((rows[2].detail as ComputeDetail).entityAgreementBps['ball'], 9800);
    expect((rows[3].detail as ProofDetail).hasSp1, isFalse);
    expect((rows[4].detail as SettlementDetail).payouts.single.amountUnits, 10000000);
    expect(rows[5].detail, isA<TermsDetail>());
  });

  test('World models', () {
    final e = WorldEvent.fromJson({
      'id': 'e1',
      'title': 'Fed cuts',
      'category': 'econ',
      'close_time_ms': 5,
      'status': 'open',
      'contracts': [
        {'id': 'c1', 'label': 'Yes', 'prob_bps': 6200, 'bid_bps': 6100},
      ],
    });
    expect(e.contracts.single.askBps, isNull);
    expect(e.resolution, isEmpty);
    expect(const QuoteLeg(eventId: 'e1', contractId: 'c1', side: 'yes').toJson(),
        {'event_id': 'e1', 'contract_id': 'c1', 'side': 'yes'});
  });

  group('WS messages (§12.4)', () {
    test('bet / draft / start / notify / chain / unknown', () {
      expect(WsMessage.fromJson({'type': 'bet', 'bet': betJson()}), isA<WsBet>());
      expect(WsMessage.fromJson({'type': 'draft', 'huddle_id': 'h1', 'draft': draftJson()}), isA<WsDraft>());
      final s = WsMessage.fromJson({
        'type': 'start',
        'bet_id': 'b',
        'beacon': {'slot': 1, 'hash_hex': '00' * 32, 'symbols': null},
        'wav_url': '/v1/x.wav',
        'sfx_url': null,
        'play_on_user_id': 'u1',
        'play_delay_ms': 1500,
      }) as WsStart;
      expect(s.beacon.symbols.length, 42);
      expect(s.playDelayMs, 1500);
      final n = WsMessage.fromJson({'type': 'notify', 'title': 'Ready', 'bet_id': 'b'}) as WsNotify;
      expect(n.title, 'Ready');
      final c = WsMessage.fromJson({
        'type': 'chain',
        'bet_id': 'b',
        'name': 'PreRuled',
        'data': {'consent_deadline': '1700000120'},
        'signature': 's',
        'slot': 5,
      }) as WsChain;
      expect(c.data['consent_deadline'], '1700000120');
      expect(WsMessage.fromJson({'type': 'pong'}), isA<WsPong>());
      expect(WsMessage.fromJson({'type': 'later'}), isA<WsUnknown>());
      expect(
        WsMessage.fromJson({
          'type': 'scene',
          'bet_id': 'b',
          'entities': [
            {'entity': 'bin', 'label': 'Trash Can', 'bbox': [1, 2, 3, 4], 'conf': 90},
          ],
          'conditions': [
            {'leg': 0, 'field': 'success', 'path': '0', 'label': 'Into Can', 'state': false, 'placed': true},
          ],
        }),
        isA<WsScene>(),
      );
    });

    test('malformed known types throw FormatException', () {
      expect(() => WsMessage.fromJson({'type': 'bet', 'bet': {'id': 1}}), throwsFormatException);
    });
  });
}
