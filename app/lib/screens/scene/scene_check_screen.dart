import 'dart:async';

import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../api/api_error.dart';
import '../../api/models/bet.dart';
import '../../api/models/calibration.dart';
import '../../api/models/program.dart';
import '../../api/models/scene.dart';
import '../../capture/cover_transform.dart';
import '../../capture/image_utils.dart';
import '../../capture/pose.dart';
import '../../capture/scene_camera.dart';
import '../../nav/routes.dart';
import '../../scene/conditions.dart';
import '../../scene/placement.dart';
import '../../state/guarded.dart';
import '../../state/ws_watch.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/page.dart';
import '../../ui/widgets/sheet.dart';
import '../../ui/widgets/text.dart';
import '../../ws/ws_messages.dart';
import 'practice_sheet.dart';
import 'scene_overlay.dart';

/// Scene check (spec §3.4/§6.5, CONTRACTS.md §12.10): camera with entity
/// labels · region placement · condition rows with state dots · Practice ·
/// Stake. Only the creator (camera owner) places regions and labels; other
/// phones see it read-only plus Stake.
class SceneCheckScreen extends StatefulWidget {
  const SceneCheckScreen({super.key, required this.args});
  final BetArgs args;

  @override
  State<SceneCheckScreen> createState() => _SceneCheckScreenState();
}

class _SceneCheckScreenState extends State<SceneCheckScreen> with Guarded, WsWatch {
  BetView? _bet;
  SceneCamera? _cam;
  PoseSource? _pose;
  StreamSubscription<SceneFrame>? _frameSub;
  final ConditionBoard _board = ConditionBoard();
  final Placement _placement = Placement();
  CalibrationDraft? _cal;
  Calibration? _saved;
  List<SceneEntity> _entities = const [];
  Timer? _latchTimer;
  bool _leaving = false;
  bool _detecting = false;
  int _frameCount = 0;
  List<Uint8List>? _practiceBuf;
  Completer<void>? _practiceFull;

  String get _betId => widget.args.betId;
  bool get _isOwner => _bet != null && _bet!.creatorUserId == app.userId;
  bool get _needsScene => _bet != null && _bet!.kind != ProgramKind.market;
  Program? get _program => _bet?.program;

  @override
  void initState() {
    super.initState();
    _bet = widget.args.bet;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      watchWs([Topics.bet(_betId)], _onWs);
      _load();
    });
  }

  @override
  void dispose() {
    _latchTimer?.cancel();
    _frameSub?.cancel();
    _cam?.close();
    _pose?.stop();
    if (_ownerLocked) SystemChrome.setPreferredOrientations(const []);
    super.dispose();
  }

  /// Portrait is locked while this phone is the camera.
  bool _ownerLocked = false;

  Future<void> _load() => guard('load', () async {
        final bet = await app.api.bet(_betId);
        _setBet(bet);
        if (_isOwner && _needsScene && bet.state == BetState.proposed) await _openCamera();
      });

  void _setBet(BetView bet) {
    if (!mounted) return;
    final cur = _bet;
    if (cur != null && cur.updatedAtMs > bet.updatedAtMs) return;
    setState(() => _bet = bet);
    app.upsertBet(bet);
    _seedFromBet(bet);
    _maybeLeave(bet);
  }

  /// Resumes from a saved calibration (re-opened screen).
  void _seedFromBet(BetView bet) {
    final c = bet.calibration;
    if (c == null || _saved != null) return;
    _saved = c;
    for (final r in c.regions) {
      _placement.regions.putIfAbsent(r.entity, () => r);
    }
    final cal = _cal;
    if (cal != null) {
      for (final e in c.entityRefs) {
        cal.correct(e.entity, e.label, e.bbox, cropSha256: e.cropSha256);
      }
    }
  }

  void _maybeLeave(BetView bet) {
    if (_leaving) return;
    String? route;
    if (bet.kind == ProgramKind.market) {
      route = Routes.ruling;
    } else if (bet.state == BetState.funded || bet.state == BetState.live) {
      route = Routes.record;
    } else if (bet.state != BetState.proposed) {
      route = Routes.ruling;
    }
    if (route == null) return;
    _leaving = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Navigator.of(context).pushReplacementNamed(route!, arguments: BetArgs(bet.id, bet: bet));
    });
  }

  Future<void> _openCamera() async {
    _ownerLocked = true;
    unawaited(SystemChrome.setPreferredOrientations(const [DeviceOrientation.portraitUp]));
    final cam = _cam ??= app.newSceneCamera();
    try {
      await cam.open();
    } catch (_) {
      throw ApiException('NO_CAMERA');
    }
    final meta = cam.meta;
    if (meta == null) throw ApiException('NO_CAMERA');
    final cal = _cal = CalibrationDraft(camera: meta);
    final saved = _saved;
    if (saved != null) {
      for (final e in saved.entityRefs) {
        cal.correct(e.entity, e.label, e.bbox, cropSha256: e.cropSha256);
      }
    }
    _pose = app.newPoseSource()..start();
    _frameSub = cam.frames(fps: 10).listen(_onFrame);
    if (mounted) setState(() {});
  }

  // ---- live scene -----------------------------------------------------------

  void _onFrame(SceneFrame f) {
    _frameCount++;
    final buf = _practiceBuf;
    if (buf != null && buf.length < 50) {
      buf.add(f.jpeg);
      if (buf.length >= 50) _practiceFull?.complete();
    }
    final ws = app.ws;
    if (ws != null && ws.isConnected) {
      ws.sendSceneFrame(_betId, f.jpeg, f.tMs);
    } else if (!_detecting && _frameCount % 10 == 1) {
      // Single-frame fallback (~1 fps) while the socket is down.
      _detecting = true;
      app.api.sceneDetect(_betId, f.jpeg).then(_applyScene).catchError((Object _) {}).whenComplete(() => _detecting = false);
    }
  }

  void _onWs(WsMessage m) {
    switch (m) {
      case WsBet(:final bet) when bet.id == _betId:
        _setBet(bet);
      case WsScene(:final betId, :final update) when betId == _betId:
        _applyScene(update);
      default:
        break;
    }
  }

  void _applyScene(SceneUpdate u) {
    if (!mounted) return;
    _board.update(u.conditions);
    final cal = _cal;
    final p = _program;
    if (cal != null && p != null) {
      final names = {for (final e in p.entities) if (!e.isRegion) e.name};
      for (final e in u.entities) {
        if (names.contains(e.entity)) cal.detected(e.entity, e.label, e.bbox);
      }
    }
    setState(() => _entities = u.entities);
    if (u.conditions.any((c) => c.state)) {
      _latchTimer?.cancel();
      _latchTimer = Timer(const Duration(milliseconds: kLatchMs), () {
        if (mounted) setState(() {});
      });
    }
  }

  // ---- placement --------------------------------------------------------------

  void _beginRegion(ProgramEntity e) {
    if (!_isOwner || _cal == null) return;
    setState(() => _placement.beginRegion(e));
  }

  void _beginLabel(String entity) {
    if (!_isOwner || _cal == null) return;
    setState(() => _placement.beginLabel(entity));
  }

  void _onTap(CoverTransform t, Offset local) {
    if (!_isOwner || !_placement.active) return;
    final p = t.toImage(local);
    if (_placement.step == PlacementStep.labelTarget) {
      final entity = _placement.takeLabelTarget();
      if (entity != null) _correctLabel(entity, p);
      setState(() {});
      return;
    }
    final region = _placement.tap(p);
    setState(() {});
    if (region != null) _saveIfComplete();
  }

  void _finishZone() {
    if (_placement.finishZone() != null) {
      setState(() {});
      _saveIfComplete();
    }
  }

  /// Label correction: the tapped object's box (or a box around the tap)
  /// becomes the entity's reference, and its crop is uploaded.
  Future<void> _correctLabel(String entity, List<int> p) async {
    final cal = _cal;
    final cam = _cam;
    if (cal == null || cam == null) return;
    final bbox = smallestContaining(_entities.map((e) => e.bbox), p) ?? boxAround(p);
    final label = _bet?.labels[entity] ?? entity;
    cal.correct(entity, label, bbox);
    setState(() {});
    await guard('crop', () async {
      final sha = await _uploadCrop(cam, entity, bbox);
      cal.setCrop(entity, sha);
    }, exclusive: false);
    _saveIfComplete();
  }

  Future<String> _uploadCrop(SceneCamera cam, String entity, List<int> bbox) async {
    final still = await cam.still();
    Uint8List crop;
    try {
      // The still is ≤ 640 px, so a synchronous crop is cheap.
      crop = toUploadJpegSync(still, crop: bbox).jpeg;
    } catch (_) {
      crop = still;
    }
    return app.api.putSceneCrop(_betId, entity, crop);
  }

  Set<String> get _unplaced {
    final p = _program;
    if (p == null) return const {};
    return {for (final e in p.regions) if (!(_placement.regions[e.name]?.valid ?? false)) e.name};
  }

  bool get _complete => _program != null && _unplaced.isEmpty;

  /// `PUT /bets/:id/calibration` once every region is placed and whenever it
  /// changes afterwards (the live rows use the last PUT calibration).
  Future<void> _saveIfComplete() async {
    if (!_complete || !_isOwner) return;
    await guard('save', () => _save(), exclusive: false);
  }

  Future<void> _save() async {
    final cal = _cal;
    final cam = _cam;
    final p = _program;
    if (cal == null || cam == null || p == null) return;
    if (cal.refFrameSha256 == null) {
      final ref = await cam.still();
      cal.refFrameSha256 = crypto.sha256.convert(ref).toString();
      cal.pose = _pose?.current;
    }
    final built = cal.build(p, _placement.regions);
    if (sameCalibration(built, _saved)) return;
    final r = await app.api.putCalibration(_betId, built);
    _saved = Calibration.fromJson(r.calibration);
  }

  // ---- practice / stake ----------------------------------------------------------

  Future<void> _practice() => guard('practice', () async {
        _practiceBuf = [];
        final full = _practiceFull = Completer<void>();
        await full.future.timeout(const Duration(seconds: 6), onTimeout: () {});
        final frames = _practiceBuf ?? const [];
        _practiceBuf = null;
        _practiceFull = null;
        if (frames.isEmpty) throw ApiException('NO_CAMERA');
        final res = await app.api.practice(_betId, frames);
        if (mounted) await showAppSheet<void>(context, (_) => PracticeSheet(rows: practiceRows(res)));
      });

  Future<void> _stake() => guard('stake', () async {
        final bet = _bet!;
        if (_isOwner && bet.kind == ProgramKind.rules) {
          if (!_complete) throw ApiException('CALIBRATION_INCOMPLETE');
          await _save();
        }
        await app.tx.run(() => app.api.fund(_betId));
        _setBet(await app.api.bet(_betId));
      });

  // ---- UI ----------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final bet = _bet;
    final p = bet?.program;
    final me = bet?.me;
    final rows = p == null ? const <ConditionRow>[] : _board.rows(p, bet!.conditions, unplaced: _unplaced);
    return AppPage(
      title: 'Scene check',
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ErrorLine(error),
          Row(children: [
            if (_isOwner && _cam != null && rows.isNotEmpty) ...[
              Expanded(
                child: QuietButton(
                  label: 'Practice',
                  busy: busyWith('practice'),
                  onPressed: busy ? null : _practice,
                ),
              ),
              const SizedBox(width: Space.x2),
            ],
            Expanded(
              child: me != null && me.funded
                  ? const QuietButton(label: 'Staked', onPressed: null)
                  : PrimaryButton(
                      label: 'Stake',
                      busy: busyWith('stake'),
                      onPressed: me != null && bet!.state == BetState.proposed && !busy ? _stake : null,
                    ),
            ),
          ]),
        ],
      ),
      child: ListView(
        children: [
          const SizedBox(height: Space.x1),
          if (_isOwner) _viewfinder(),
          if (bet != null && p != null) ...[
            const SizedBox(height: Space.x2),
            for (final e in p.entities.where((e) => !e.isRegion)) ...[
              ListRow(
                key: ValueKey('entity-${e.name}'),
                label: bet.labels[e.name] ?? e.name,
                labelIsData: true,
                value: _confText(e.name),
                onTap: _isOwner && _cal != null ? () => _beginLabel(e.name) : null,
              ),
              const Hairline(),
            ],
            for (final e in p.regions) ...[
              ListRow(
                key: ValueKey('region-${e.name}'),
                label: bet.labels[e.name] ?? e.name,
                labelIsData: true,
                value: (_placement.regions[e.name]?.valid ?? false) ? 'Placed' : (_isOwner ? 'Place' : 'Waiting'),
                chevron: _isOwner && _cal != null,
                onTap: _isOwner && _cal != null ? () => _beginRegion(e) : null,
              ),
              const Hairline(),
            ],
            const SizedBox(height: Space.x2),
            for (final r in rows) ...[
              ListRow(
                key: ValueKey('condition-${r.key}'),
                label: r.label,
                labelIsData: true,
                trailing: StatusDot(on: r.on, placed: r.placed),
              ),
              const Hairline(),
            ],
          ],
          const SizedBox(height: Space.x2),
        ],
      ),
    );
  }

  String _confText(String entity) {
    for (final d in _entities) {
      if (d.entity == entity) return '${d.conf}%';
    }
    final ref = _cal?.refs[entity];
    return ref == null ? '—' : 'Set';
  }

  Widget _viewfinder() {
    final cam = _cam;
    final meta = cam?.meta;
    return AspectRatio(
      aspectRatio: 3 / 4,
      child: ClipRRect(
        borderRadius: const BorderRadius.all(Radius.circular(12)),
        child: ColoredBox(
          color: Palette.surface,
          child: cam == null || meta == null || !cam.isOpen
              ? const Center(child: Icon(LucideIcons.camera, size: 32, color: Palette.secondary))
              : LayoutBuilder(builder: (context, c) {
                  final t = CoverTransform(
                    box: Size(c.maxWidth, c.maxHeight),
                    image: Size(meta.widthPx.toDouble(), meta.heightPx.toDouble()),
                  );
                  return GestureDetector(
                    key: const ValueKey('viewfinder'),
                    behavior: HitTestBehavior.opaque,
                    onTapUp: (d) => _onTap(t, d.localPosition),
                    child: Stack(fit: StackFit.expand, children: [
                      cam.preview(),
                      SceneOverlay(
                        transform: t,
                        boxes: _overlayBoxes(),
                        regions: _placement.regions.values.toList(),
                        pending: _placement.pending,
                        onLabelTap: _beginLabel,
                      ),
                      if (_placement.step.prompt != null) _placementBar(),
                    ]),
                  );
                }),
        ),
      ),
    );
  }

  List<OverlayBox> _overlayBoxes() {
    final p = _program;
    final bet = _bet;
    if (p == null || bet == null) return const [];
    final openings = openingEntities(p);
    final out = <OverlayBox>[];
    final shown = <String>{};
    for (final d in _entities) {
      if (!shown.add(d.entity)) continue;
      final corrected = _cal?.corrected.contains(d.entity) ?? false;
      final bbox = corrected ? _cal!.refs[d.entity]!.bbox : d.bbox;
      out.add(OverlayBox(
        entity: d.entity,
        label: bet.labels[d.entity] ?? d.label,
        bbox: bbox,
        conf: corrected ? null : d.conf,
        opening: openings.contains(d.entity) ? openingRect(bbox) : null,
      ));
    }
    final cal = _cal;
    if (cal != null) {
      for (final e in cal.corrected) {
        if (shown.contains(e)) continue;
        final r = cal.refs[e]!;
        out.add(OverlayBox(
          entity: e,
          label: bet.labels[e] ?? r.label,
          bbox: r.bbox,
          opening: openings.contains(e) ? openingRect(r.bbox) : null,
        ));
      }
    }
    return out;
  }

  Widget _placementBar() {
    return Positioned(
      left: Space.x2,
      right: Space.x2,
      bottom: Space.x2,
      child: Row(children: [
        Expanded(child: Label(_placement.step.prompt!, style: Typo.labelStrong)),
        if (_placement.step == PlacementStep.zoneCorners)
          AppChip(label: 'Done', onTap: _placement.canFinishZone ? _finishZone : null),
        const SizedBox(width: Space.x1),
        AppChip(label: 'Cancel', onTap: () => setState(_placement.cancel)),
      ]),
    );
  }
}
