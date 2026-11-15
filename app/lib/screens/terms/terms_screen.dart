import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_error.dart';
import '../../api/models/bet.dart';
import '../../api/models/draft.dart';
import '../../api/models/huddle.dart';
import '../../api/models/program.dart';
import '../../capture/voice_capture.dart';
import '../../core/format.dart';
import '../../nav/routes.dart';
import '../../state/guarded.dart';
import '../../state/ws_watch.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/page.dart';
import '../../ui/widgets/sheet.dart';
import '../../ui/widgets/text.dart';
import '../../ws/ws_messages.dart';
import 'accept_sheet.dart';
import 'question_chips.dart';
import 'terms_sheets.dart';

/// Terms (spec §6.5, CONTRACTS.md §12.10): Dictate · Who · What · Stake ·
/// Limit · question chips · acceptance status per participant · Accept
/// (counterparties) / Continue (creator, once everyone has accepted).
class TermsScreen extends StatefulWidget {
  const TermsScreen({super.key, required this.args});
  final TermsArgs args;

  @override
  State<TermsScreen> createState() => _TermsScreenState();
}

class _TermsScreenState extends State<TermsScreen> with Guarded, WsWatch {
  DraftView? _draft;
  HuddleView? _huddle;
  VoiceCapture? _mic;
  bool _dictating = false;
  bool _agentAsked = false;
  bool _leaving = false;
  String? _following;
  final Set<String> _spoken = {};

  String? get _me => app.userId;
  bool get _isCreator => _huddle?.creatorUserId == _me;
  DraftParticipant? get _mine {
    final d = _draft;
    if (d == null) return null;
    for (final p in d.participants) {
      if (p.userId == _me) return p;
    }
    return null;
  }

  bool get _editable => _isCreator && !(_draft?.frozen ?? false) && !busy;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      watchWs([Topics.huddle(widget.args.huddleId)], _onWs);
      _load();
    });
  }

  @override
  void dispose() {
    _mic?.dispose();
    super.dispose();
  }

  Future<void> _load() => guard('load', () async {
        final h = await app.api.huddle(widget.args.huddleId);
        if (mounted) setState(() => _huddle = h);
        final id = widget.args.draftId;
        if (id != null) {
          _setDraft(await app.api.draft(id));
        } else {
          // A draft that arrived before the huddle loaded may already name its bet.
          final d = _draft;
          if (d != null) _follow(d);
        }
      });

  void _setDraft(DraftView d) {
    final cur = _draft;
    if (!mounted) return;
    if (cur != null && cur.draftId == d.draftId && cur.updatedAtMs > d.updatedAtMs) return;
    setState(() => _draft = d);
    _speakNext(d);
    _follow(d);
  }

  /// Every non-creator phone (counterparties and bystanders) follows the
  /// creator once the draft names its confirmed bet. Only `huddle:<id>`
  /// reaches every member, so the draft update is the signal; the bet is
  /// fetched and matched on `program_hash`.
  void _follow(DraftView d) {
    final id = d.betId;
    if (id == null || _leaving || _following == id || _huddle == null || _isCreator) return;
    _following = id;
    unawaited(_followBet(id, d.programHash));
  }

  Future<void> _followBet(String id, String? programHash) async {
    try {
      final bet = await app.api.bet(id);
      if (!mounted || _leaving) return;
      if (programHash != null && bet.programHash != programHash) return;
      app.upsertBet(bet);
      _goToBet(bet);
    } on ApiException {
      // Not visible yet: the next draft/bet update retries.
      if (_following == id) _following = null;
    }
  }

  /// Speaks the first unanswered question not spoken yet.
  void _speakNext(DraftView d) {
    for (final q in d.questions) {
      if (q.kind == QuestionKind.region || q.audioUrl == null) continue;
      if (_spoken.add('${d.draftId}/${q.id}/${d.updatedAtMs}')) {
        unawaited(app.audio.play(q.audioUrl!).catchError((Object _) {}));
      }
      return;
    }
  }

  void _onWs(WsMessage m) {
    switch (m) {
      case WsDraft(:final huddleId, :final draft) when huddleId == widget.args.huddleId:
        _setDraft(draft);
      case WsHuddle(:final huddle) when huddle.id == widget.args.huddleId:
        setState(() => _huddle = huddle);
        final d = _draft;
        if (d != null) _follow(d);
      case WsNotify(:final betId) when betId != null && _huddle != null && !_isCreator && _draft?.programHash != null:
        // Counterparties also hear "Bet offered" on the `user` topic.
        if (!_leaving && _following != betId) {
          _following = betId;
          unawaited(_followBet(betId, _draft!.programHash));
        }
      case WsBet(:final bet):
        final d = _draft;
        if (d != null && d.programHash != null && bet.programHash == d.programHash && !_isCreator) {
          _goToBet(bet);
        }
      default:
        break;
    }
  }

  void _goToBet(BetView bet) {
    if (_leaving || !mounted) return;
    _leaving = true;
    final route = bet.kind == ProgramKind.market ? Routes.ruling : Routes.scene;
    Navigator.of(context).pushReplacementNamed(route, arguments: BetArgs(bet.id, bet: bet));
  }

  // ---- dictation ----------------------------------------------------------

  Future<void> _toggleDictation() async {
    if (!_dictating) {
      await guard('dictate', () async {
        if (!_agentAsked) {
          _agentAsked = true;
          // Agent mode is advisory here: both modes use record-and-compile.
          try {
            await app.api.agentSession(huddleId: widget.args.huddleId, draftId: _draft?.draftId);
          } on ApiException {
            // Compile still works without an Agent session.
          }
        }
        final mic = _mic ??= app.newVoiceCapture();
        if (!await mic.hasPermission()) throw ApiException('PHRASE_NOT_HEARD');
        await mic.start();
        if (mounted) setState(() => _dictating = true);
      });
      return;
    }
    await guard('compile', () async {
      final wav = await _mic!.stop();
      if (mounted) setState(() => _dictating = false);
      final d = await app.api.compile(huddleId: widget.args.huddleId, audioWav: wav, draftId: _draft?.draftId);
      _setDraft(d);
    });
  }

  // ---- edits ----------------------------------------------------------------

  Future<void> _answer(Question q, String answer) => guard('answer', () async {
        final d = _draft!;
        _setDraft(await app.api.compile(huddleId: widget.args.huddleId, draftId: d.draftId, answers: {q.id: answer}));
      });

  Future<void> _editWho() async {
    final d = _draft;
    final h = _huddle;
    if (d == null || h == null || !_editable) return;
    final r = await showAppSheet<WhoResult>(context, (_) => WhoSheet(huddle: h, draft: d, creatorId: _me!));
    if (r == null || !mounted) return;
    await guard('patch', () async {
      _setDraft(await app.api.patchDraft(d.draftId, participants: r.participants, sides: r.sides));
    });
  }

  Future<void> _editStake() async {
    final d = _draft;
    if (d == null || !_editable) return;
    final units = await showAppSheet<int>(context, (_) => StakeSheet(current: d.program?.stakeEach));
    if (units == null || !mounted) return;
    await guard('patch', () async => _setDraft(await app.api.patchDraft(d.draftId, stakeEachUnits: units)));
  }

  Future<void> _editLimit() async {
    final d = _draft;
    if (d == null || !_editable) return;
    final s = await showAppSheet<int>(context, (_) => LimitSheet(current: d.program?.timeLimitS));
    if (s == null || !mounted) return;
    await guard('patch', () async => _setDraft(await app.api.patchDraft(d.draftId, timeLimitS: s)));
  }

  void _showWhat() {
    final d = _draft;
    if (d == null) return;
    showAppSheet<void>(
      context,
      (_) => WhatSheet(
        lines: d.readback ?? const [],
        onPlay: d.readback == null
            ? null
            : () => unawaited(app.audio
                .play(d.readbackAudioUrl ?? '/drafts/${Uri.encodeComponent(d.draftId)}/readback.mp3')
                .catchError((Object _) {})),
      ),
    );
  }

  // ---- accept / continue ----------------------------------------------------

  Future<void> _accept() async {
    final d = _draft;
    if (d == null) return;
    final ok = await showAppSheet<bool>(context, (_) => AcceptSheet(app: app, draft: d));
    if (ok == true && mounted) {
      await guard('refresh', () async => _setDraft(await app.api.draft(d.draftId)));
    }
  }

  Future<void> _continue() => guard('continue', () async {
        final d = _draft!;
        final first = await app.api.createBet(d.draftId);
        await app.tx.run(() async => (await app.api.createBet(d.draftId)).sign, first: first.sign);
        BetView bet = first.bet;
        try {
          bet = await app.api.bet(first.bet.id);
        } on ApiException {
          // keep the snapshot from POST /bets
        }
        app.upsertBet(bet);
        _goToBet(bet);
      });

  void _world() => Navigator.of(context).pushNamed(
        Routes.world,
        arguments: WorldArgs(huddleId: widget.args.huddleId, draftId: _draft?.draftId),
      );

  // ---- UI ---------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final d = _draft;
    final p = d?.program;
    final invalid = d?.status == DraftStatus.invalid;
    return AppPage(
      title: 'Terms',
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ErrorLine(error ?? (invalid ? ApiException('DRAFT_INVALID').message : null)),
          _primary(d),
        ],
      ),
      child: ListView(
        children: [
          const SizedBox(height: Space.x1),
          Row(children: [
            Expanded(
              child: d?.title == null
                  ? const SizedBox(height: Space.x5)
                  : DataText(d!.title!, key: const ValueKey('draft-title'), style: Typo.title),
            ),
            if (d?.kind == ProgramKind.aiJudged) const Tag('AI-judged'),
          ]),
          if (_isCreator) ...[
            const SizedBox(height: Space.x2),
            Center(
              child: ShutterButton(
                semanticLabel: 'Dictate',
                active: _dictating,
                onPressed: (_editable || _dictating) && !busyWith('compile') ? _toggleDictation : null,
              ),
            ),
          ],
          const SizedBox(height: Space.x2),
          if (d != null) ...[
            const Hairline(),
            ListRow(
              label: 'Who',
              value: d.participants.map((p) => p.displayName).join(', '),
              chevron: _editable,
              onTap: _editable ? _editWho : null,
            ),
            const Hairline(),
            ListRow(label: 'What', value: d.title ?? '', chevron: true, onTap: _showWhat),
            const Hairline(),
            ListRow(
              label: 'Stake',
              value: _stakeText(p),
              chevron: _editable,
              onTap: _editable ? _editStake : null,
            ),
            const Hairline(),
            ListRow(
              label: 'Limit',
              value: p == null ? '' : formatSeconds(p.timeLimitS),
              chevron: _editable,
              onTap: _editable ? _editLimit : null,
            ),
            const Hairline(),
            for (final q in d.questions)
              if (q.kind != QuestionKind.region)
                QuestionChips(
                  key: ValueKey('question-${d.draftId}-${q.id}-${d.updatedAtMs}'),
                  question: q,
                  enabled: _isCreator && !busy && !d.frozen,
                  onAnswer: (a) => _answer(q, a),
                  onReplay: q.audioUrl == null ? null : () => unawaited(app.audio.play(q.audioUrl!).catchError((Object _) {})),
                ),
            const SizedBox(height: Space.x2),
            for (final part in d.participants) ...[
              ListRow(
                key: ValueKey('acceptance-${part.userId}'),
                label: part.displayName,
                labelIsData: true,
                value: part.isCreator ? 'Creator' : (part.accepted ? 'Accepted' : 'Waiting'),
                trailing: StatusDot(on: part.isCreator || part.accepted),
              ),
              const Hairline(),
            ],
          ],
          const SizedBox(height: Space.x2),
          Row(children: [AppChip(label: 'World', onTap: _world)]),
          const SizedBox(height: Space.x2),
        ],
      ),
    );
  }

  String _stakeText(Program? p) {
    if (p == null) return '';
    if (p.stakeEach != null) return formatUsd(p.stakeEach!);
    final s = p.stakes;
    if (s != null && s.isNotEmpty) return s.map(formatUsd).join(' / ');
    return '';
  }

  Widget _primary(DraftView? d) {
    if (d == null) {
      return const QuietButton(label: 'Waiting', onPressed: null);
    }
    final ready = d.status == DraftStatus.ready && d.programHash != null;
    if (_isCreator) {
      return PrimaryButton(
        label: 'Continue',
        busy: busyWith('continue'),
        onPressed: ready && d.allCounterpartiesAccepted && !busy ? _continue : null,
      );
    }
    final mine = _mine;
    if (mine == null) return const QuietButton(label: 'Waiting', onPressed: null);
    if (mine.accepted) return const QuietButton(label: 'Accepted', onPressed: null);
    return PrimaryButton(label: 'Accept', onPressed: ready && !busy ? _accept : null);
  }
}
