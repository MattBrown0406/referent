// Share to ReferralFit, the native side: the iOS share extension added by
// expo-share-intent (app.json) saves what was shared in the app group and
// opens referralfit://dataUrl=…, and its hook hands the share to App.tsx.
// Only on an iPhone build that has the extension: a JS update reaching an
// older build (no ExpoShareIntentModule or ExpoLinking module) never loads
// expo-share-intent, whose import would need them. The web app has none of it.
// Rules for the text itself: share-intake.ts. docs/DAY_REVIEW.md.
import { requireOptionalNativeModule } from 'expo';
import * as FileSystem from 'expo-file-system/legacy';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import type { ShareIntent } from 'expo-share-intent';
import type { ShareIntentOptions } from 'expo-share-intent/build/ExpoShareIntentModule.types';

import { isTextFile, sharedNote, type SharedFileText, type SharedNote, type SharedPayload } from './share-intake';

type ShareHook = (options: ShareIntentOptions) => {
  hasShareIntent: boolean;
  shareIntent: ShareIntent;
  resetShareIntent: (clearNativeModule?: boolean) => void;
  error: string | null;
};

const EMPTY: ShareIntent = { files: null, text: null, webUrl: null, type: null };
const noShare: ShareHook = () => ({ hasShareIntent: false, shareIntent: EMPTY, resetShareIntent: () => undefined, error: null });

function shareHook(): ShareHook {
  try {
    if (Platform.OS !== 'ios' || !requireOptionalNativeModule('ExpoShareIntentModule') || !requireOptionalNativeModule('ExpoLinking')) return noShare;
    return (require('expo-share-intent') as { useShareIntent: ShareHook }).useShareIntent;
  } catch {
    return noShare;
  }
}

// Chosen once, so every render calls the same hook.
const useShareHook = shareHook();

/** This build can receive a share from another app (the ReferralFit share extension is in it). */
export const shareToAppSupported = useShareHook !== noShare;

// Kept by App.tsx until it is taken: iOS clears nothing here once it is read,
// and a Face ID prompt or a trip to Settings must not drop it.
const SHARE_OPTIONS: ShareIntentOptions = { resetOnBackground: false, disabled: !shareToAppSupported };

/**
 * Calls `onShare` for each share that arrives, with what it says, and clears
 * it from the share extension's storage at once. iOS can deliver one share
 * twice (as the app opens and as it becomes active): App.tsx drops the
 * repeat by its shareKey.
 */
export function useIncomingShare(onShare: (payload: SharedPayload) => void): void {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareHook(SHARE_OPTIONS);
  const onShareRef = useRef(onShare);
  onShareRef.current = onShare;
  const resetRef = useRef(resetShareIntent);
  resetRef.current = resetShareIntent;
  useEffect(() => {
    if (!hasShareIntent) return;
    // A new object for each delivery, so a second one runs this again.
    resetRef.current(true);
    onShareRef.current(shareIntent as SharedPayload);
  }, [hasShareIntent, shareIntent]);
}

/**
 * The note a share makes, reading a shared .txt file when that is what came
 * (copied into the app group by the extension). Every copied file is then
 * deleted, read or not: nothing shared stays on the phone outside the box.
 */
export async function readSharedNote(payload: SharedPayload): Promise<SharedNote | null> {
  const files = (payload.files || []).filter((file) => file?.path);
  const texts: SharedFileText[] = [];
  if (isBlank(payload.text) && isBlank(payload.webUrl)) {
    for (const file of files.filter(isTextFile).slice(0, 3)) {
      try {
        texts.push({ name: file.fileName || '', text: await FileSystem.readAsStringAsync(file.path!) });
      } catch {
        // Unreadable: treated as not shared.
      }
    }
  }
  await Promise.all(files.map((file) => FileSystem.deleteAsync(file.path!, { idempotent: true }).catch(() => undefined)));
  return sharedNote(payload, texts);
}

function isBlank(value: string | null | undefined): boolean {
  return !(typeof value === 'string' && value.trim());
}
