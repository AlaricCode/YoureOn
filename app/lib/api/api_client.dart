import 'dart:typed_data';

import '../core/bytes.dart';
import 'models/bet.dart';
import 'models/booth.dart';
import 'models/calibration.dart';
import 'models/chunk.dart';
import 'models/draft.dart';
import 'models/huddle.dart';
import 'models/identity.dart';
import 'models/json.dart';
import 'models/receipt.dart';
import 'models/ruling.dart';
import 'models/scene.dart';
import 'models/sign.dart';
import 'models/user.dart';
import 'models/world.dart';
import 'transport.dart';

/// `{bet, sign}` from `POST /bets` and `POST /world/bets`.
class BetWithSign {
  const BetWithSign(this.bet, this.sign);
  final BetView bet;
  final SignRequest sign;

  factory BetWithSign.fromJson(Object? v) {
    final j = asJson(v);
    return BetWithSign(BetView.fromJson(j['bet']), SignRequest.fromJson(j['sign']));
  }
}

/// Typed client for every route in CONTRACTS.md §12.3.
class ApiClient {
  ApiClient(this.t);

  final ApiTransport t;

  static String _e(String s) => Uri.encodeComponent(s);

  // ---- auth -------------------------------------------------------------

  Future<String> authNonce() async =>
      decode(await t.getJson('/auth/nonce', auth: false), (v) => asString(asJson(v)['nonce']));

  Future<bool> emailStart(String email) async => decode(
        await t.postJson('/auth/email/start', {'email': email}, false),
        (v) => asBool(asJson(v)['sent']),
      );

  Future<Session> createSession({
    required String provider, // google | email
    required String credential,
    String? emailCode,
    required String wallet,
    required String nonce,
    required Uint8List walletSig,
  }) async =>
      decode(
        await t.postJson(
          '/auth/session',
          {
            'provider': provider,
            'credential': credential,
            if (emailCode != null) 'email_code': emailCode,
            'wallet': wallet,
            'nonce': nonce,
            'wallet_sig_b64': toB64(walletSig),
          },
          false,
        ),
        Session.fromJson,
      );

  Future<UserView> me() async => decode(await t.getJson('/me'), UserView.fromJson);

  // ---- enroll -----------------------------------------------------------

  Future<EnrollChallenge> enrollChallenge() async =>
      decode(await t.getJson('/enroll/challenge'), EnrollChallenge.fromJson);

  /// Enrollment uploads run the face / voice model on every capture, which
  /// on a CPU-only embedder can take well over the default 30 s.
  static const Duration enrollTimeout = Duration(minutes: 2);

  /// [frames]: full-frame JPEGs ≤ 640 px long side; `frames[0]` neutral,
  /// `frames[1..2]` in `face_prompts` order, extras neutral (3..5 total).
  Future<FaceEnrollResult> enrollFace(String challengeId, List<Uint8List> frames) async {
    if (frames.length < 3 || frames.length > 5) throw ArgumentError('3..5 frames');
    return decode(
      await t.postJsonSlow(
        '/enroll/face',
        {
          'challenge_id': challengeId,
          'frames_b64': [for (final f in frames) toB64(f)],
        },
        timeout: enrollTimeout,
      ),
      FaceEnrollResult.fromJson,
    );
  }

  Future<bool> enrollVoice(String challengeId, List<Uint8List> wavClips) async {
    if (wavClips.length != 3) throw ArgumentError('3 clips');
    return decode(
      await t.postJsonSlow(
        '/enroll/voice',
        {
          'challenge_id': challengeId,
          'clips_b64': [for (final c in wavClips) toB64(c)],
        },
        timeout: enrollTimeout,
      ),
      (v) => asBool(asJson(v)['ok']),
    );
  }

  Future<EnrollComplete> enrollComplete({required String displayName}) async => decode(
        await t.postJson('/enroll/complete', {'consent': true, 'display_name': displayName}),
        EnrollComplete.fromJson,
      );

  /// `DELETE /enroll/pending`: drops captured but not completed templates
  /// (consent withdrawn, or Enroll left before Done). Idempotent.
  Future<void> enrollDiscard() async {
    await t.delete('/enroll/pending');
  }

  Future<SignRequest> enrollDelete() async =>
      decode(await t.delete('/enroll'), (v) => SignRequest.fromJson(asJson(v)['sign']));

  // ---- money ------------------------------------------------------------

  Future<int> balance() async =>
      decode(await t.getJson('/balance'), (v) => asInt(asJson(v)['usdc_units']));

  Future<int> faucet() async =>
      decode(await t.postJson('/faucet'), (v) => asInt(asJson(v)['usdc_units']));

  // ---- huddles ----------------------------------------------------------

  Future<HuddleCreated> createHuddle() async =>
      decode(await t.postJson('/huddles'), HuddleCreated.fromJson);

  Future<HuddleView> joinHuddle(String code) async =>
      decode(await t.postJson('/huddles/join', {'code': code}), HuddleView.fromJson);

  Future<HuddleView> huddle(String id) async =>
      decode(await t.getJson('/huddles/${_e(id)}'), HuddleView.fromJson);

  Future<List<FaceMatch>> scanHuddle(String id, List<FaceCrop> faces) async => decode(
        await t.postJson('/huddles/${_e(id)}/scan', {
          'faces': [for (final f in faces) f.toJson()],
        }),
        (v) => asList(asJson(v)['matches'], FaceMatch.fromJson),
      );

  Future<HuddleView> removeMember(String huddleId, String userId) async =>
      decode(await t.delete('/huddles/${_e(huddleId)}/members/${_e(userId)}'), HuddleView.fromJson);

  // ---- drafts -----------------------------------------------------------

  Future<DraftView> compile({
    required String huddleId,
    String? transcript,
    Uint8List? audioWav,
    String? draftId,
    Map<String, String>? answers,
  }) async =>
      decode(
        await t.postJson('/bets/compile', {
          'huddle_id': huddleId,
          if (transcript != null) 'transcript': transcript,
          if (audioWav != null) 'audio_b64': toB64(audioWav),
          if (draftId != null) 'draft_id': draftId,
          if (answers != null)
            'answers': [
              for (final e in answers.entries) {'question_id': e.key, 'answer': e.value},
            ],
        }),
        DraftView.fromJson,
      );

  Future<DraftView> draft(String id) async =>
      decode(await t.getJson('/drafts/${_e(id)}'), DraftView.fromJson);

  Future<DraftView> patchDraft(
    String id, {
    int? stakeEachUnits,
    int? timeLimitS,
    Map<String, int>? sides,
    List<String>? participants,
  }) async =>
      decode(
        await t.patchJson('/drafts/${_e(id)}', {
          if (stakeEachUnits != null) 'stake_each_units': stakeEachUnits,
          if (timeLimitS != null) 'time_limit_s': timeLimitS,
          if (sides != null) 'sides': sides,
          if (participants != null) 'participants': participants,
        }),
        DraftView.fromJson,
      );

  Future<Uint8List> readbackAudio(String draftId) => t.getBytes('/drafts/${_e(draftId)}/readback.mp3');

  Future<AcceptChallenge> acceptChallenge(String draftId) async =>
      decode(await t.getJson('/drafts/${_e(draftId)}/accept/challenge'), AcceptChallenge.fromJson);

  Future<AcceptResult> accept(
    String draftId, {
    required String challengeId,
    required Uint8List audioWav,
    required Uint8List acceptSig,
  }) async =>
      decode(
        await t.postJson('/drafts/${_e(draftId)}/accept', {
          'challenge_id': challengeId,
          'audio_b64': toB64(audioWav),
          'accept_sig_b64': toB64(acceptSig),
        }),
        AcceptResult.fromJson,
      );

  Future<AgentSession> agentSession({required String huddleId, String? draftId}) async => decode(
        await t.postJson('/agent/session', {
          'huddle_id': huddleId,
          if (draftId != null) 'draft_id': draftId,
        }),
        AgentSession.fromJson,
      );

  // ---- bets -------------------------------------------------------------

  Future<BetWithSign> createBet(String draftId) async =>
      decode(await t.postJson('/bets', {'draft_id': draftId}), BetWithSign.fromJson);

  Future<List<BetView>> bets({BetState? state}) async => decode(
        await t.getJson('/bets', query: state == null ? null : {'state': state.wire}),
        (v) => asList(asJson(v)['bets'], BetView.fromJson),
      );

  Future<BetView> bet(String id) async => decode(await t.getJson('/bets/${_e(id)}'), BetView.fromJson);

  Future<SceneUpdate> sceneDetect(String betId, Uint8List jpeg) async => decode(
        await t.postJson('/bets/${_e(betId)}/scene/detect', {'frame_b64': toB64(jpeg)}),
        SceneUpdate.fromJson,
      );

  Future<String> putSceneCrop(String betId, String entity, Uint8List jpeg) async => decode(
        await t.putBytes('/bets/${_e(betId)}/scene/crops/${_e(entity)}', jpeg, contentType: 'image/jpeg'),
        (v) => asString(asJson(v)['crop_sha256']),
      );

  Future<CalibrationSaved> putCalibration(String betId, Calibration c) async =>
      decode(await t.putJson('/bets/${_e(betId)}/calibration', c.toJson()), CalibrationSaved.fromJson);

  Future<List<PracticeCondition>> practice(String betId, List<Uint8List> frames) async {
    if (frames.length > 50) throw ArgumentError('at most 50 frames');
    return decode(
      await t.postJson('/bets/${_e(betId)}/practice', {
        'frames_b64': [for (final f in frames) toB64(f)],
      }),
      (v) => asList(asJson(v)['conditions'], PracticeCondition.fromJson),
    );
  }

  Future<SignRequest> fund(String betId) async =>
      decode(await t.postJson('/bets/${_e(betId)}/fund'), (v) => SignRequest.fromJson(asJson(v)['sign']));

  Future<WitnessRegistered> registerWitness(String betId, {required String witnessKey, required String kind}) async =>
      decode(
        await t.postJson('/bets/${_e(betId)}/witnesses', {'witness_key': witnessKey, 'kind': kind}),
        WitnessRegistered.fromJson,
      );

  Future<void> start(String betId) async => t.postJson('/bets/${_e(betId)}/start');

  Future<ChunkAccepted> postChunk(String betId, ChunkRecord record) async =>
      decode(await t.postJson('/bets/${_e(betId)}/chunks', record.toJson()), ChunkAccepted.fromJson);

  /// Uploads a chunk body. Uses the server's `upload_url` when given.
  Future<void> putChunkBody(String betId, String witnessKey, int index, Uint8List body, {String? uploadUrl}) async {
    final target = uploadUrl ?? '/bets/${_e(betId)}/chunks/${_e(witnessKey)}/$index';
    await t.putBytes(target, body, contentType: 'application/octet-stream');
  }

  Future<Uint8List> chunkBody(String betId, String witnessKey, int index) =>
      t.getBytes('/bets/${_e(betId)}/chunks/${_e(witnessKey)}/$index');

  Future<void> end(String betId) async => t.postJson('/bets/${_e(betId)}/end');

  Future<RulingView> ruling(String betId) async =>
      decode(await t.getJson('/bets/${_e(betId)}/ruling'), RulingView.fromJson);

  Future<SignRequest> consent(String betId) async =>
      decode(await t.postJson('/bets/${_e(betId)}/consent'), (v) => SignRequest.fromJson(asJson(v)['sign']));

  Future<({SignRequest sign, int bondUnits})> dispute(String betId, int reason) async {
    if (reason < 1 || reason > 4) throw ArgumentError('reason 1..4');
    return decode(await t.postJson('/bets/${_e(betId)}/dispute', {'reason': reason}), (v) {
      final j = asJson(v);
      return (sign: SignRequest.fromJson(j['sign']), bondUnits: asInt(j['bond_units']));
    });
  }

  Future<BoothRecord> booth(String betId) async =>
      decode(await t.getJson('/bets/${_e(betId)}/booth'), BoothRecord.fromJson);

  Future<Uint8List> exhibit(String betId, String eid) => t.getBytes('/bets/${_e(betId)}/exhibits/${_e(eid)}');

  Future<List<ReceiptRow>> receipt(String betId) async => decode(
        await t.getJson('/bets/${_e(betId)}/receipt'),
        (v) => asList(asJson(v)['rows'], ReceiptRow.fromJson),
      );

  Future<Uint8List> announceAudio(String betId) => t.getBytes('/bets/${_e(betId)}/announce.mp3');

  // ---- pay --------------------------------------------------------------

  Future<PayChallenge> payChallenge() async => decode(await t.getJson('/pay/challenge'), PayChallenge.fromJson);

  Future<PayScanResult> payScan(String challengeId, {required Uint8List neutral, required Uint8List prompted}) async =>
      decode(
        await t.postJson('/pay/scan', {
          'challenge_id': challengeId,
          'faces_b64': [toB64(neutral), toB64(prompted)],
        }),
        PayScanResult.fromJson,
      );

  Future<PayScanResult> payVoice(Uint8List wav) async =>
      decode(await t.postJson('/pay/voice', {'audio_b64': toB64(wav)}), PayScanResult.fromJson);

  Future<SignRequest> pay({required String toUserId, required int amountUnits}) async => decode(
        await t.postJson('/pay', {'to_user_id': toUserId, 'amount_units': amountUnits}),
        (v) => SignRequest.fromJson(asJson(v)['sign']),
      );

  // ---- world ------------------------------------------------------------

  Future<List<WorldEvent>> worldEvents({String? q, int? limit}) async => decode(
        await t.getJson('/world/events', query: {
          if (q != null && q.isNotEmpty) 'q': q,
          if (limit != null) 'limit': '$limit',
        }),
        (v) => asList(asJson(v)['events'], WorldEvent.fromJson),
      );

  Future<WorldEvent> worldEvent(String id) async =>
      decode(await t.getJson('/world/events/${_e(id)}'), WorldEvent.fromJson);

  Future<WorldQuote> worldQuote(List<QuoteLeg> legs, int totalUnits) async => decode(
        await t.postJson('/world/quote', {
          'legs': [for (final l in legs) l.toJson()],
          'total_units': totalUnits,
        }),
        WorldQuote.fromJson,
      );

  Future<BetWithSign> worldBet({required String quoteId, required String counterpartyUserId}) async => decode(
        await t.postJson('/world/bets', {'quote_id': quoteId, 'counterparty_user_id': counterpartyUserId}),
        BetWithSign.fromJson,
      );

  /// §11.6 hedge (stretch); request and response are passed through.
  Future<Object?> worldHedge(String betId, Json body) => t.postJson('/world/bets/${_e(betId)}/hedge', body);

  Future<List<LeaderboardRow>> leaderboard({String? huddleId}) async => decode(
        await t.getJson('/leaderboard', query: huddleId == null ? null : {'huddle_id': huddleId}),
        (v) => asList(asJson(v)['rows'], LeaderboardRow.fromJson),
      );

  // ---- tx ---------------------------------------------------------------

  Future<TxResult> submitTx(String txId, Uint8List signature) async => decode(
        await t.postJson('/tx/${_e(txId)}/submit', {'signature_b64': toB64(signature)}),
        TxResult.fromJson,
      );
}
