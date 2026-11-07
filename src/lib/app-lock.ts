import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

// "Lock with Face ID" and the app-switcher cover: the local native module in
// modules/app-lock (iOS only). The cover is a window of its own above every
// sheet, so it hides an open case file too. The setting is per phone and is
// read natively at launch, before anything draws. Elsewhere (the web app, an
// older build without the module) every call here is a no-op and
// appLockStatus() returns null, which hides the setting.

export type AppLockBiometry = 'faceID' | 'touchID' | 'opticID' | 'none';

export type AppLockStatus = {
  // A passcode is set, so the lock can be opened.
  available: boolean;
  // What unlocks it first; 'none' means the passcode only.
  biometry: AppLockBiometry;
  enabled: boolean;
  // Time away before it locks again; 0 = every time.
  graceSeconds: number;
};

export type AppLockEnableResult = { ok: boolean; error?: string };

type AppLockNative = {
  getStatus(): AppLockStatus;
  enable(graceSeconds: number, reason: string): Promise<AppLockEnableResult>;
  disable(): void;
  setGraceSeconds(seconds: number): void;
};

const native: AppLockNative | null = Platform.OS === 'ios' ? requireOptionalNativeModule<AppLockNative>('AppLock') : null;

export const APP_LOCK_GRACE_OPTIONS: { seconds: number; label: string }[] = [
  { seconds: 0, label: 'Every time' },
  { seconds: 60, label: 'After 1 minute' },
  { seconds: 300, label: 'After 5 minutes' },
];

export const DEFAULT_APP_LOCK_GRACE_SECONDS = 60;

// Touching the module creates it; its OnCreate starts the cover. index.ts
// calls this before the first render.
export function startAppLock(): void {
  native?.getStatus();
}

export function appLockStatus(): AppLockStatus | null {
  if (!native) return null;
  try {
    return native.getStatus();
  } catch {
    return null;
  }
}

export async function enableAppLock(graceSeconds: number): Promise<AppLockEnableResult> {
  if (!native) return { ok: false, error: 'unavailable' };
  return native.enable(graceSeconds, 'Turn on the lock for ReferralFit.');
}

export function disableAppLock(): void {
  native?.disable();
}

export function setAppLockGrace(seconds: number): void {
  native?.setGraceSeconds(seconds);
}

export function appLockName(biometry: AppLockBiometry): string {
  if (biometry === 'faceID') return 'Face ID';
  if (biometry === 'touchID') return 'Touch ID';
  if (biometry === 'opticID') return 'Optic ID';
  return 'passcode';
}

// What to tell someone whose attempt to turn the lock on did not finish.
export function appLockEnableMessage(error: string | undefined): string | null {
  if (!error || error === 'cancelled' || error === 'busy') return null;
  if (error === 'passcodeNotSet' || error === 'unavailable') {
    return 'Set a passcode for this iPhone in Settings > Face ID & Passcode first. The lock needs it.';
  }
  return 'That did not unlock, so the lock is still off. Try again.';
}
