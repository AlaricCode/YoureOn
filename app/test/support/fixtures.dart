// JSON fixtures shaped exactly like CONTRACTS.md §12.2.

Map<String, dynamic> userJson({
  String id = 'u1',
  String name = 'Ana',
  bool face = true,
  bool voice = true,
  String wallet = '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj',
}) =>
    {
      'id': id,
      'wallet': wallet,
      'display_name': name,
      'enrolled': {'face': face, 'voice': voice},
    };

Map<String, dynamic> programJson() => {
      'version': 2,
      'kind': 'rules',
      'participants': ['9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj', 'jX5drmcKNVNaeBTsLD4TZC183vsMpJqdALAz8a1BQG9'],
      'sides': [0, 1],
      'entities': [
        {'name': 'shooter', 'kind': 'person', 'participant': 1},
        {'name': 'ball', 'kind': 'object', 'phrase': 'paper ball'},
        {'name': 'bin', 'kind': 'object', 'phrase': 'trash can'},
        {'name': 'line', 'kind': 'region', 'shape': 'line'},
      ],
      'legs': [
        {
          'id': 1,
          'actor_bound': true,
          'attempt_window_frames': 50,
          'success': {
            'op': 'disappears_into',
            'a': {'e': 'ball'},
            'b': {'e': 'bin', 'sub': 'opening'},
          },
          'rule': {'kind': 'exists'},
        }
      ],
      'outcome': {
        'if_true': 1,
        'condition': {'op': 'leg', 'id': 1},
        'else': 0,
      },
      'stake_each': 5000000,
      'time_limit_s': 120,
    };

Map<String, dynamic> betJson({
  String id = 'jX5drmcKNVNaeBTsLD4TZC183vsMpJqdALAz8a1BQG9',
  String state = 'preruled',
  String title = 'Paper ball shot',
  int myIndex = 1,
  int updatedAt = 1700000000000,
  Map<String, dynamic>? settlement,
}) =>
    {
      'id': id,
      'title': title,
      'kind': 'rules',
      'ai_judged': false,
      'state': state,
      'state_label': 'Ruled',
      'creator_user_id': 'u1',
      'participants': [
        {
          'user_id': 'u1',
          'display_name': 'Ana',
          'wallet': '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj',
          'side': 0,
          'accepted': true,
          'funded': true,
          'consent': 'pending',
        },
        {
          'user_id': 'u2',
          'display_name': 'Ben',
          'wallet': 'jX5drmcKNVNaeBTsLD4TZC183vsMpJqdALAz8a1BQG9',
          'side': 1,
          'accepted': true,
          'funded': true,
          'consent': 'agree',
        },
      ],
      'my_index': myIndex,
      'my_role': 'participant',
      'stake_each_units': 5000000,
      'stakes_units': [5000000, 5000000],
      'pot_units': 10000000,
      'time_limit_s': 120,
      'actor_bound': true,
      'program': programJson(),
      'yaml': 'version: 2\n',
      'readback': ['Ben gets the paper ball into the opening of the trash can', 'Ben wins if leg 1; otherwise Ana wins'],
      'program_hash': 'ab' * 32,
      'labels': {'ball': 'Paper Ball', 'bin': 'Trash Can', 'line': 'Line', 'shooter': 'Ben'},
      'calibration': {
        'version': 1,
        'scene': {
          'camera': {'width_px': 1920, 'height_px': 1080, 'orientation': 'landscape'},
          'entity_refs': [
            {'entity': 'bin', 'label': 'Trash Can', 'bbox': [6000, 5000, 8000, 9000]},
          ],
        },
        'regions': [
          {'entity': 'line', 'shape': 'line', 'points': [[3000, 6000], [3000, 10000]], 'behind_sign': 1},
        ],
      },
      'calibration_hash': 'cd' * 32,
      'conditions': [
        {'leg': 0, 'field': 'success', 'path': '', 'label': 'Into Can'},
      ],
      'deadlines_ms': {'fund': null, 'start': null, 'live_end': null, 'consent': 1700000120000, 'panel': null},
      'started_at_ms': 1699999000000,
      't0_ms': 1699999002100,
      'ended_at_ms': 1699999120000,
      'witnesses': [
        {'id': 'w0', 'label': 'Camera 1', 'kind': 'camera', 'user_id': 'u1', 'synced': true},
        {'id': 'w1', 'label': 'Mic 1', 'kind': 'audio', 'user_id': 'u1', 'synced': null},
      ],
      'gap_mask': 0,
      'preruling': {
        'code': 1,
        'reason': 0,
        'winner_side': 1,
        'winner_mask': 2,
        'leg_results': [1],
        'consent_deadline_ms': 1700000120000,
      },
      'dispute': null,
      'booth_status': null,
      'settlement': settlement,
      'refund_reason': null,
      'updated_at_ms': updatedAt,
    };

Map<String, dynamic> draftJson() => {
      'draft_id': 'd1',
      'huddle_id': 'h1',
      'status': 'needs_clarification',
      'kind': 'rules',
      'title': 'Paper ball shot',
      'questions': [
        {'id': 'line', 'text': 'Where is the throw line?', 'kind': 'region', 'chips': [], 'entity': 'line', 'audio_url': null},
        {'id': 'stake', 'text': 'Stake each?', 'kind': 'choice', 'chips': [r'$1', r'$5', r'$10'], 'audio_url': '/v1/drafts/d1/q/stake.mp3'},
      ],
      'labels': {'ball': 'Paper Ball'},
      'participants': [
        {'user_id': 'u1', 'display_name': 'Ana', 'side': 0, 'accepted': false, 'is_creator': true},
        {'user_id': 'u2', 'display_name': 'Ben', 'side': 1, 'accepted': true, 'is_creator': false},
      ],
      'warnings': [
        {'path': 'entities[2]', 'code': 'UNUSED_ENTITY', 'message': 'unused'},
      ],
      'frozen': false,
      'readback_audio_url': null,
      'updated_at_ms': 1,
    };

Map<String, dynamic> huddleJson({String id = 'h1', String creator = 'u1', bool benConfirmed = true, String code = '482913'}) => {
      'id': id,
      'code': code,
      'creator_user_id': creator,
      'members': [
        {'user': userJson(id: 'u1', name: 'Ana'), 'joined_at_ms': 1, 'confirmed': true},
        {
          'user': userJson(id: 'u2', name: 'Ben', wallet: 'jX5drmcKNVNaeBTsLD4TZC183vsMpJqdALAz8a1BQG9'),
          'joined_at_ms': 2,
          'confirmed': benConfirmed,
        },
      ],
    };

Map<String, dynamic> signJson(String txId, {String summary = r'Stake $5.00'}) => {
      'tx_id': txId,
      'message_b64': 'AQID',
      'expires_at_ms': 0,
      'summary': summary,
    };

Map<String, dynamic> confirmedJson() => {'status': 'confirmed', 'signature': 'sig', 'error': null};

/// A ready draft: program + read-back + hash, Ben (u2) is the counterparty.
Map<String, dynamic> readyDraftJson({bool benAccepted = false, int updatedAt = 2}) => {
      ...draftJson(),
      'status': 'ready',
      'questions': [
        {'id': 'line', 'text': 'Where is the throw line?', 'kind': 'region', 'chips': [], 'entity': 'line', 'audio_url': null},
      ],
      'program': programJson(),
      'yaml': 'version: 2\n',
      'readback': ['Ben gets the paper ball into the opening of the trash can', r'$5.00 each'],
      'program_hash': 'ab' * 32,
      'participants': [
        {'user_id': 'u1', 'display_name': 'Ana', 'side': 0, 'accepted': false, 'is_creator': true},
        {'user_id': 'u2', 'display_name': 'Ben', 'side': 1, 'accepted': benAccepted, 'is_creator': false},
      ],
      'frozen': benAccepted,
      'updated_at_ms': updatedAt,
    };

/// A bet as seen by Ana (u1, the creator, index 0).
Map<String, dynamic> creatorBetJson({String id = 'b1', String state = 'proposed', bool funded = false, Object? calibration}) {
  final b = betJson(id: id, state: state, myIndex: 0);
  final parts = [for (final p in b['participants'] as List) Map<String, dynamic>.from(p as Map)];
  parts[0]['funded'] = funded;
  return {
    ...b,
    'participants': parts,
    'calibration': calibration,
    'calibration_hash': null,
    'conditions': [
      {'leg': 1, 'field': 'success', 'path': '', 'label': 'Into Can'},
    ],
    'preruling': state == 'preruled' ? b['preruling'] : null,
  };
}

Map<String, dynamic> rulingJson({bool canRespond = true, int? amount = -5000000}) => {
      'outcome_text': 'You lose',
      'preruling': 1,
      'readback': ['Ben gets the paper ball into the opening of the trash can'],
      'legs': [
        {'id': 1, 'result': 1, 'decisive_frames': [42]},
      ],
      'amount_units': amount,
      'can_respond': canRespond,
      'bond_units': 1000000,
    };

List<Map<String, dynamic>> receiptRowsJson() => [
      {
        'key': 'verified',
        'label': 'Verified',
        'status': 'ok',
        'url': null,
        'detail': {
          'key': 'verified',
          'participants': [
            {'name': 'Ana', 'accepted': true, 'voice_cos_bps': null},
            {'name': 'Ben', 'accepted': true, 'voice_cos_bps': 8123},
          ],
          'bio_checks': [
            {'participant_name': 'Ben', 'frame': 42, 'modality': 'face'},
          ],
          'cross_check_ok': true,
          'audio_disagree': false,
          'phone_disagree': false,
        },
      },
      {
        'key': 'terms',
        'label': 'Terms',
        'status': 'ok',
        'url': null,
        'detail': {'key': 'terms', 'program_hash': 'ab' * 32, 'readback': ['Ben wins if leg 1'], 'yaml_url': '/bets/b1/yaml'},
      },
      {
        'key': 'evidence',
        'label': 'Evidence',
        'status': 'ok',
        'url': null,
        'detail': {
          'key': 'evidence',
          'evidence_root': 'cd' * 32,
          'gap_mask': 0,
          'witnesses': [
            {'label': 'Camera 1', 'chunks': 24, 'synced': true, 'gap': false, 'late_chunks': 0, 'gaps_ms': [120]},
          ],
        },
      },
      {'key': 'compute', 'label': 'Compute', 'status': 'pending', 'url': null, 'detail': null},
      {
        'key': 'proof',
        'label': 'Proof',
        'status': 'ok',
        'url': null,
        'detail': {
          'key': 'proof',
          'biometric': [
            {'participant_name': 'Ben', 'modality': 'face', 'frame': 42, 'tx_url': 'https://explorer.solana.com/tx/abc'},
          ],
          'binding': 'trusted',
          'sp1': null,
        },
      },
      {
        'key': 'settlement',
        'label': 'Settlement',
        'status': 'none',
        'url': 'https://explorer.solana.com/tx/settle',
        'detail': {'key': 'settlement', 'path': 'consent', 'tx_url': null, 'payouts': []},
      },
    ];

Map<String, dynamic> worldEventJson({String id = 'e1'}) => {
      'id': id,
      'title': 'Fed cuts rates in December',
      'category': 'economics',
      'close_time_ms': 1800000000000,
      'status': 'open',
      'contracts': [
        {'id': 'c1', 'label': 'Cut', 'prob_bps': 7000},
        {'id': 'c2', 'label': 'Hold', 'prob_bps': 3000},
      ],
    };

Map<String, dynamic> quoteJson() => {
      'quote_id': 'q1',
      'p_bps': 7000,
      'proposer_units': 7000000,
      'counterparty_units': 3000000,
      'legs': [
        {'event_id': 'e1', 'contract_id': 'c1', 'side': 'yes', 'prob_bps': 7000},
      ],
      'expires_at_ms': 1800000000000,
    };
