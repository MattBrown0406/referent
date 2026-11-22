import * as Clipboard from 'expo-clipboard';
import { Alert, Platform, Share } from 'react-native';
import type { ShareAction, ShareContent } from 'react-native';

// React Native Web's Share.share resolves with nothing (the app reads
// result.action) and rejects outright where the browser has no share sheet.
// On the web, installWebShare() uses the browser's share sheet when there is
// one, and otherwise copies the text and says so. Either way it resolves
// like the native one; the packet composer still asks whether it went.
async function webShare(content: ShareContent): Promise<ShareAction> {
  const message = 'message' in content ? content.message ?? '' : '';
  const url = 'url' in content ? content.url ?? '' : '';
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (nav?.share) {
    try {
      await nav.share({ title: content.title, text: message || undefined, url: url || undefined });
      return { action: Share.sharedAction };
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return { action: Share.dismissedAction };
      // Not allowed here (no user gesture, an iframe): copy instead.
    }
  }
  const text = [message, url && !message.includes(url) ? url : ''].filter(Boolean).join('\n\n');
  if (await copyForSure(text)) {
    Alert.alert('Copied', 'It is on your clipboard. Paste it into an email or a message.');
  } else {
    // Never "Copied" when it was not: show the text to select and copy by hand.
    Alert.alert('Copy this', text);
  }
  return { action: Share.sharedAction };
}

/**
 * Copies and says whether it really did. expo-clipboard's web fallback
 * reports success even when the browser refused the copy (after a wait,
 * outside the tap), so the result of each step is checked here.
 */
export async function copyForSure(text: string): Promise<boolean> {
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { clipboard?: { writeText?: (value: string) => Promise<void> } };
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(text);
      return true;
    } catch { /* refused: try the older way */ }
  }
  if (typeof document === 'undefined') return Clipboard.setStringAsync(text).catch(() => false);
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(area);
  }
  return copied;
}

let installed = false;

export function installWebShare(): void {
  if (Platform.OS !== 'web' || installed) return;
  installed = true;
  Share.share = webShare;
}
