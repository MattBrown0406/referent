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
  if (!(await Clipboard.setStringAsync(text))) throw new Error('Could not copy to the clipboard');
  Alert.alert('Copied', 'It is on your clipboard. Paste it into an email or a message.');
  return { action: Share.sharedAction };
}

let installed = false;

export function installWebShare(): void {
  if (Platform.OS !== 'web' || installed) return;
  installed = true;
  Share.share = webShare;
}
