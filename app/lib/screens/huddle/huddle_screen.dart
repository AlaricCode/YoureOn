import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../api/api_error.dart';
import '../../api/models/huddle.dart';
import '../../capture/face_capture.dart';
import '../../nav/routes.dart';
import '../../state/guarded.dart';
import '../../state/ws_watch.dart';
import '../../ui/tokens.dart';
import '../../ui/widgets/controls.dart';
import '../../ui/widgets/page.dart';
import '../../ui/widgets/sheet.dart';
import '../../ws/ws_messages.dart';
import 'face_crops.dart';
import 'join_sheet.dart';

/// Huddle (spec §6.5, CONTRACTS.md §12.13): Camera · Participant chips
/// (confirmed members) · Code · Continue. The creator pans the camera
/// across the group; matched members are confirmed by the server.
class HuddleScreen extends StatefulWidget {
  const HuddleScreen({super.key, this.args = const HuddleArgs()});
  final HuddleArgs args;

  @override
  State<HuddleScreen> createState() => _HuddleScreenState();
}

class _HuddleScreenState extends State<HuddleScreen> with Guarded, WsWatch {
  HuddleView? _huddle;
  FaceCapture? _cam;
  bool _leaving = false;

  bool get _isCreator => _huddle != null && _huddle!.creatorUserId == app.userId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _cam?.close();
    super.dispose();
  }

  Future<void> _load() => guard('load', () async {
        final a = widget.args;
        final HuddleView h;
        if (a.huddleId != null) {
          h = await app.api.huddle(a.huddleId!);
        } else if (a.joinCode != null) {
          h = await app.api.joinHuddle(a.joinCode!);
        } else {
          final created = await app.api.createHuddle();
          h = await app.api.huddle(created.huddleId);
        }
        await _enter(h);
      });

  Future<void> _enter(HuddleView h) async {
    releaseTopics();
    if (!mounted) return;
    setState(() => _huddle = h);
    watchWs([Topics.huddle(h.id)], _onWs);
    if (h.creatorUserId == app.userId) {
      await _openCamera();
    } else {
      await _cam?.close();
      if (mounted) setState(() => _cam = null);
    }
  }

  Future<void> _openCamera() async {
    final cam = _cam ??= app.newFaceCapture();
    try {
      await cam.open(front: false);
    } catch (_) {
      throw ApiException('NO_CAMERA');
    }
    if (mounted) setState(() {});
  }

  void _onWs(WsMessage m) {
    final h = _huddle;
    if (h == null) return;
    switch (m) {
      case WsHuddle(:final huddle) when huddle.id == h.id:
        setState(() => _huddle = huddle);
      case WsDraft(:final huddleId, :final draft) when huddleId == h.id && !_isCreator && !_leaving:
        // A counterparty follows the creator to Terms.
        _leaving = true;
        Navigator.of(context).pushReplacementNamed(
          Routes.terms,
          arguments: TermsArgs(huddleId: h.id, draftId: draft.draftId),
        );
      default:
        break;
    }
  }

  Future<void> _scan() => guard('scan', () async {
        final cam = _cam;
        final h = _huddle;
        if (cam == null || h == null || !cam.isOpen) return;
        final frame = await cam.capture();
        if (frame.faces.isEmpty) throw ApiException('FACE_NOT_MATCHED');
        final matches = await app.api.scanHuddle(h.id, faceCrops(frame));
        final fresh = await app.api.huddle(h.id);
        if (mounted) setState(() => _huddle = fresh);
        if (!matches.any((m) => m.matched)) throw ApiException('FACE_NOT_MATCHED');
      });

  Future<void> _join() async {
    final code = await showAppSheet<String>(context, (_) => const JoinSheet());
    if (code == null || !mounted) return;
    await guard('join', () async => _enter(await app.api.joinHuddle(code)));
  }

  Future<void> _remove(HuddleMember m) => guard('remove', () async {
        final h = await app.api.removeMember(_huddle!.id, m.user.id);
        if (mounted) setState(() => _huddle = h);
      });

  void _continue() {
    final h = _huddle;
    if (h == null) return;
    Navigator.of(context).pushNamed(Routes.terms, arguments: TermsArgs(huddleId: h.id));
  }

  void _world() {
    Navigator.of(context).pushNamed(Routes.world, arguments: WorldArgs(huddleId: _huddle?.id));
  }

  @override
  Widget build(BuildContext context) {
    final h = _huddle;
    final confirmed = h?.confirmed.length ?? 0;
    return AppPage(
      title: 'Huddle',
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ErrorLine(error),
          if (h == null || _isCreator)
            PrimaryButton(
              label: 'Continue',
              onPressed: h != null && confirmed >= 2 && !busy ? _continue : null,
            )
          else
            const QuietButton(label: 'Waiting', onPressed: null),
        ],
      ),
      child: ListView(
        children: [
          const SizedBox(height: Space.x1),
          if (h == null || _isCreator) _camera(),
          const SizedBox(height: Space.x2),
          if (h != null) ...[
            Wrap(
              spacing: Space.x1,
              runSpacing: Space.x1,
              children: [
                for (final m in h.members)
                  GestureDetector(
                    key: ValueKey('member-${m.user.id}'),
                    onLongPress: _isCreator && m.user.id != app.userId ? () => _remove(m) : null,
                    child: AppChip(label: m.user.displayName, isData: true, selected: m.confirmed),
                  ),
              ],
            ),
            const SizedBox(height: Space.x2),
            const Hairline(),
            KeyValueRow(label: 'Code', value: h.code),
            const Hairline(),
          ],
          const SizedBox(height: Space.x2),
          Row(children: [
            AppChip(label: 'Join', onTap: busy ? null : _join),
            const SizedBox(width: Space.x1),
            AppChip(label: 'World', onTap: h == null ? null : _world),
          ]),
        ],
      ),
    );
  }

  Widget _camera() {
    final cam = _cam;
    return AspectRatio(
      aspectRatio: 3 / 4,
      child: ClipRRect(
        borderRadius: const BorderRadius.all(Radius.circular(12)),
        child: ColoredBox(
          color: Palette.surface,
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (cam != null && cam.isOpen)
                cam.preview()
              else
                const Center(child: Icon(LucideIcons.users, size: 32, color: Palette.secondary)),
              Positioned(
                bottom: Space.x2,
                left: 0,
                right: 0,
                child: Center(
                  child: ShutterButton(
                    semanticLabel: 'Scan',
                    active: busyWith('scan'),
                    onPressed: cam != null && cam.isOpen && !busy ? _scan : null,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
