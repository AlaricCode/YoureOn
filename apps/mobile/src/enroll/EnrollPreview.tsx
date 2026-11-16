// Opens the sign-up and face enrollment screens from the diagnostics screen until sign-up (D0-M4) and
// navigation land. Uses the in-memory face API and the preview embedder (see ./embedder.ts), so it
// runs with no server face routes. Lazy-loaded, so a missing native module fails only this.
import { useMemo, useState } from 'react';

import { createPreviewSignupApi } from '../signup/api';
import { SignupScreen } from '../signup/SignupScreen';
import { createPreviewFaceApi } from './api';
import { createPreviewEmbedder } from './embedder';
import { FaceEnrollFlow, FaceSettings } from './EnrollScreens';

/** `signup` runs the new-user path: sign up → consent → register face → face settings. */
export type EnrollPreviewMode = 'signup' | 'flow' | 'settings';

export default function EnrollPreview({
  initial,
  onClose,
}: {
  initial: EnrollPreviewMode;
  onClose: () => void;
}) {
  const api = useMemo(() => createPreviewFaceApi({ delayMs: 600 }), []);
  const embedder = useMemo(() => createPreviewEmbedder(), []);
  const signupApi = useMemo(() => createPreviewSignupApi({ delayMs: 600 }), []);
  const [mode, setMode] = useState<EnrollPreviewMode>(initial);

  if (mode === 'signup') {
    return <SignupScreen api={signupApi} preview onSignedUp={() => setMode('flow')} />;
  }
  return mode === 'flow' ? (
    <FaceEnrollFlow
      api={api}
      embedder={embedder}
      onDone={() => setMode('settings')}
      onSkip={onClose}
      onExit={onClose}
    />
  ) : (
    <FaceSettings api={api} onBack={onClose} onSetUp={() => setMode('flow')} />
  );
}
