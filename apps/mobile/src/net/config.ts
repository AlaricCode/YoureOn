// Where the phone talks to (API-CONTRACT §1.1). EXPO_PUBLIC_API_URL is inlined by Metro at build
// time: per EAS profile in eas.json, or from apps/mobile/.env.local in `expo start` (a phone on
// the LAN needs the laptop's IP, e.g. http://192.168.1.20:8080; localhost only works in the
// simulator). Metro only inlines the literal `process.env.EXPO_PUBLIC_API_URL` expression.
import appJson from '../../app.json';

export const DEV_API_URL = 'http://localhost:8080';

export function resolveApiUrl(fromEnv: string | undefined): string {
  const raw = fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : DEV_API_URL;
  return raw.replace(/\/+$/, '');
}

export const API_BASE_URL = resolveApiUrl(process.env.EXPO_PUBLIC_API_URL);

/** X-App-Version: `<semver>+<build>` (API-CONTRACT §1.2). */
export const APP_VERSION = `${appJson.expo.version}+${process.env.EXPO_PUBLIC_BUILD ?? 'dev'}`;
