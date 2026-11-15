import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../api/api_error.dart';
import '../state/app_controller.dart';
import '../state/app_scope.dart';
import '../ui/tokens.dart';
import '../ui/widgets/controls.dart';
import '../ui/widgets/page.dart';
import '../ui/widgets/sheet.dart';
import '../ui/widgets/text.dart';
import '../wallet/wallet.dart';
import 'enroll/enroll_capture.dart';
import 'enroll/enroll_flow.dart';

/// The three screens of first-time enrollment, in order.
enum _Step { consent, face, voice }

/// Enroll (CONTRACTS.md §12.13) as a sequence of three screens:
///   1 Consent        → "I consent" checkbox, Continue
///   2 Register face  → a series of photos, Continue once saved
///   3 Register voice → three phrases, Done once saved
/// Each screen has a back arrow: Voice → Face → Consent → Sign in (signs
/// out). Captured templates stay pending until Done; withdrawing consent or
/// leaving deletes them (DELETE /enroll/pending).
/// In enrolled mode (Profile): what is saved, "Delete biometrics" (asks
/// to confirm) and "Sign out".
class EnrollScreen extends StatefulWidget {
  const EnrollScreen({super.key});

  @override
  State<EnrollScreen> createState() => _EnrollScreenState();
}

class _EnrollScreenState extends State<EnrollScreen> {
  late final AppController _app = AppScope.read(context);
  // Created on first use, so dispose() can tell whether anything was started
  // without looking up the (by then deactivated) AppScope.
  EnrollFlow? _flowInstance;
  EnrollFlow get _flow => _flowInstance ??= EnrollFlow(_app.api);
  _Step _step = _Step.consent;
  bool _busy = false;
  String? _error;

  /// Set once Done succeeded: leaving the screen then must not discard.
  bool _completed = false;

  @override
  void dispose() {
    // Left before Done: nothing captured may outlive the screen without
    // consent being completed. Best effort; the backend also expires
    // pending templates after 24 h.
    final flow = _flowInstance;
    if (!_completed && flow != null && flow.hasPending) {
      unawaited(flow.discardPending().catchError((Object _) {}));
    }
    super.dispose();
  }

  Future<void> _guard(Future<void> Function() f) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await f();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on WalletLockedException {
      // dismissed
    } catch (_) {
      if (mounted) setState(() => _error = ApiException('INTERNAL').message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ---- navigation -------------------------------------------------------------

  void _go(_Step step) => setState(() {
        _error = null;
        _step = step;
      });

  /// Back arrow and system back: Voice → Face → Consent → Sign in.
  void _back() {
    if (_busy) return;
    switch (_step) {
      case _Step.voice:
        _go(_Step.face);
      case _Step.face:
        _go(_Step.consent);
      case _Step.consent:
        unawaited(_leaveToSignIn());
    }
  }

  /// Back from Consent: drop anything captured, then sign out so the app
  /// returns to the Sign in screen.
  Future<void> _leaveToSignIn() => _guard(() async {
        final flow = _flowInstance;
        if (flow != null && flow.hasPending) {
          try {
            await flow.discardPending();
          } catch (_) {
            // The backend also expires pending templates after 24 h.
          }
        }
        await _app.signOut();
      });

  /// Consent checkbox. Unchecking it deletes anything already captured.
  void _setConsent(bool on) {
    if (on) {
      setState(() => _flow.consent = true);
      return;
    }
    if (!_flow.hasPending) {
      setState(() => _flow.consent = false);
      return;
    }
    unawaited(_guard(() async {
      await _flow.discardPending();
      if (mounted) setState(() => _flow.consent = false);
    }));
  }

  // ---- finish / delete --------------------------------------------------------

  Future<void> _done() => _guard(() async {
        final name = _app.user?.displayName ?? '';
        final first = await _app.api.enrollComplete(displayName: name);
        await _app.tx.run(
          () async => (await _app.api.enrollComplete(displayName: name)).sign,
          first: first.sign,
        );
        _completed = true;
        await _app.refreshUser();
        if (mounted && Navigator.of(context).canPop()) Navigator.of(context).pop();
      });

  /// "Delete biometrics" → a sheet asking to confirm; only "Yes, delete"
  /// deletes.
  Future<void> _onDeleteTap() async {
    final yes = await showAppSheet<bool>(context, (c) => const _ConfirmDeleteSheet());
    if (yes == true && mounted) await _delete();
  }

  Future<void> _delete() => _guard(() async {
        final sign = await _app.api.enrollDelete();
        await _app.tx.run(_app.api.enrollDelete, first: sign);
        _completed = false;
        _flow
          ..resetChallenge()
          ..consent = false;
        await _app.refreshUser();
      });

  // ---- UI -------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final user = AppScope.of(context).user;
    final enrolled = user?.enrolled ?? false;
    // The Profile view is only for the screen opened from Home (a pushed
    // route). The app's root Enroll screen (shown while not enrolled) never
    // switches to it: when enrollment completes, the app fades that screen
    // out to Home, and showing Profile there would flash it. Same for a screen
    // that has just finished enrolling.
    final openedFromHome = !(ModalRoute.of(context)?.isFirst ?? true);
    if (!enrolled || _completed) return _sequence();
    if (!openedFromHome) {
      // Root screen, enrolled elsewhere (e.g. re-enrolled from Profile): it is
      // about to be replaced by Home; show nothing rather than a stale step.
      return const ColoredBox(color: Palette.background, child: SizedBox.expand());
    }
    return AppPage(title: 'Profile', child: _enrolled());
  }

  Widget _enrolled() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: Space.x2),
        const Row(
          children: [
            CheckBadge(size: 40, color: Palette.accent),
            SizedBox(width: Space.x2),
            Expanded(child: Label('Biometrics saved', style: Typo.heading)),
          ],
        ),
        const SizedBox(height: Space.x2),
        const BodyText(
          'Verdict can recognize you in bets, huddles and payments. Only an encrypted '
          'template is kept, not your photos or recordings.',
        ),
        const SizedBox(height: Space.x3),
        const _SavedRow(label: 'Face'),
        const Hairline(),
        const _SavedRow(label: 'Voice'),
        const Hairline(),
        const Spacer(),
        ErrorLine(_error),
        DangerButton(
          key: const ValueKey('delete-biometrics'),
          label: 'Delete biometrics',
          busy: _busy,
          onPressed: _busy ? null : _onDeleteTap,
        ),
        const SizedBox(height: Space.x2),
        QuietButton(label: 'Sign out', onPressed: _busy ? null : () => _app.signOut()),
        const SizedBox(height: Space.x2),
      ],
    );
  }

  /// First-time enrollment: one screen per step, with a back arrow and a
  /// three-segment progress bar at the top.
  Widget _sequence() {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: Scaffold(
        backgroundColor: Palette.background,
        body: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _StepHeader(step: _step.index, count: _Step.values.length, onBack: _busy ? null : _back),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: Space.page),
                  child: AnimatedSwitcher(
                    duration: Motion.fast,
                    switchInCurve: Motion.curve,
                    child: switch (_step) {
                      _Step.consent => _consentStep(),
                      _Step.face => _faceStep(),
                      _Step.voice => _voiceStep(),
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _consentStep() {
    final consent = _flow.consent;
    return _StepBody(
      key: const ValueKey('enroll-consent'),
      title: 'Your consent',
      body: 'Verdict uses your face and voice to recognize you in bet videos, confirm '
          "who's in a huddle, and let friends pay you. We keep an encrypted template, "
          'not your photos or recordings, and only a one-way hash of it goes onchain. '
          'You can delete it anytime.',
      error: _error,
      action: PrimaryButton(
        key: const ValueKey('enroll-continue'),
        label: 'Continue',
        busy: _busy,
        onPressed: consent ? () => _go(_Step.face) : null,
      ),
      child: Align(
        alignment: Alignment.topLeft,
        child: _ConsentCheck(
          value: consent,
          onChanged: _busy ? null : _setConsent,
        ),
      ),
    );
  }

  Widget _faceStep() {
    return _StepBody(
      key: const ValueKey('enroll-face'),
      title: 'Register face',
      body: 'Follow the prompts on the camera. Use good light and keep your face centered.',
      error: _error,
      action: PrimaryButton(
        key: const ValueKey('enroll-continue'),
        label: 'Continue',
        onPressed: _flow.faceDone ? () => _go(_Step.voice) : null,
      ),
      child: FaceCapturePanel(flow: _flow, onSaved: () => setState(() {})),
    );
  }

  Widget _voiceStep() {
    return _StepBody(
      key: const ValueKey('enroll-voice'),
      title: 'Register voice',
      body: 'Read each phrase aloud as it appears. Tap the button, read the phrase, '
          'then tap again to stop.',
      error: _error,
      action: PrimaryButton(
        key: const ValueKey('enroll-done'),
        label: 'Done',
        busy: _busy,
        onPressed: _flow.canFinish ? _done : null,
      ),
      child: VoiceCapturePanel(flow: _flow, onSaved: () => setState(() {})),
    );
  }
}

/// Back arrow on the left and the step progress (one segment per step).
class _StepHeader extends StatelessWidget {
  const _StepHeader({required this.step, required this.count, required this.onBack});
  final int step;
  final int count;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: Space.x6 + Space.x1,
      child: Row(
        children: [
          Semantics(
            button: true,
            label: 'Back',
            child: GestureDetector(
              key: const ValueKey('enroll-back'),
              behavior: HitTestBehavior.opaque,
              onTap: onBack,
              child: const SizedBox(
                width: Space.x6,
                height: Space.x6,
                child: Icon(LucideIcons.chevronLeft, size: 20, color: Palette.text),
              ),
            ),
          ),
          Expanded(
            child: Row(
              children: [
                for (var i = 0; i < count; i++) ...[
                  if (i > 0) const SizedBox(width: 6),
                  Expanded(
                    child: AnimatedContainer(
                      duration: Motion.fast,
                      curve: Motion.curve,
                      height: 4,
                      decoration: BoxDecoration(
                        color: i < step ? Palette.text : (i == step ? Palette.accent : Palette.hairline),
                        borderRadius: const BorderRadius.all(Radius.circular(2)),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: Space.page),
        ],
      ),
    );
  }
}

/// One enrollment screen: title, a one- or two-sentence explanation, the
/// step's content, then its error line and main button.
class _StepBody extends StatelessWidget {
  const _StepBody({
    super.key,
    required this.title,
    required this.body,
    required this.child,
    required this.action,
    this.error,
  });

  final String title;
  final String body;
  final Widget child;
  final Widget action;
  final String? error;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: Space.x2),
        Label(title, style: Typo.title),
        const SizedBox(height: Space.x1),
        BodyText(body),
        const SizedBox(height: Space.x3),
        Expanded(child: child),
        ErrorLine(error),
        action,
        const SizedBox(height: Space.x2),
      ],
    );
  }
}

/// "I consent" with a checkbox; the whole row is tappable.
class _ConsentCheck extends StatelessWidget {
  const _ConsentCheck({required this.value, required this.onChanged});
  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final change = onChanged;
    return Semantics(
      checked: value,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: change == null ? null : () => change(!value),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: Space.x1),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Checkbox(
                key: const ValueKey('consent'),
                value: value,
                onChanged: change == null ? null : (v) => change(v ?? false),
                activeColor: Palette.accent,
                checkColor: Palette.text,
                side: const BorderSide(color: Palette.secondary, width: 1.5),
                shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(4))),
              ),
              const SizedBox(width: Space.x1),
              const Label('I consent', style: Typo.labelStrong),
            ],
          ),
        ),
      ),
    );
  }
}

/// "Face · Saved ✓" on the Profile page.
class _SavedRow extends StatelessWidget {
  const _SavedRow({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    return ListRow(
      label: label,
      value: 'Saved',
      trailing: const Icon(LucideIcons.check, size: 18, color: Palette.accent),
    );
  }
}

/// Bottom sheet confirming "Delete biometrics": pops true on "Yes, delete".
class _ConfirmDeleteSheet extends StatelessWidget {
  const _ConfirmDeleteSheet();

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Label('Delete biometrics?', style: Typo.heading),
        const SizedBox(height: Space.x1),
        const BodyText(
          "Your face and voice templates are erased and removed from your profile on "
          "Solana. You'll need to enroll again before you can join a bet.",
        ),
        const SizedBox(height: Space.x3),
        Row(
          children: [
            Expanded(
              child: QuietButton(
                key: const ValueKey('delete-no'),
                label: 'No',
                onPressed: () => Navigator.of(context).pop(false),
              ),
            ),
            const SizedBox(width: Space.x2),
            Expanded(
              child: DangerButton(
                key: const ValueKey('delete-yes'),
                label: 'Yes, delete',
                filled: true,
                onPressed: () => Navigator.of(context).pop(true),
              ),
            ),
          ],
        ),
      ],
    );
  }
}
