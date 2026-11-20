// Plays the named haptic moments from ui/tokens (challenge arrived, hold, authorized, locked,
// payout, failed). Haptics go silent while a camera or the voice mic runs,
// so screens also show every moment on screen.
import * as Haptics from 'expo-haptics';

import { haptics, type HapticMoment, type HapticToken } from '../ui/tokens';

function playOne(h: HapticToken): Promise<void> {
  switch (h.kind) {
    case 'impact':
      return Haptics.impactAsync(h.style as Haptics.ImpactFeedbackStyle);
    case 'notification':
      return Haptics.notificationAsync(h.type as Haptics.NotificationFeedbackType);
    case 'selection':
      return Haptics.selectionAsync();
  }
}

export function feel(moment: HapticMoment): void {
  for (const { haptic, atMs } of haptics[moment]) {
    setTimeout(() => void playOne(haptic).catch(() => undefined), atMs);
  }
}
