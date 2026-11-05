import { Alert, Linking, Platform } from 'react-native';

export type PhoneActionResult = 'done' | 'declined' | 'failed';

// A call or a text from the phone's own dialer or Messages, which the
// caller then logs. A browser can do neither: it shows the number, and the
// action counts as done only when the person says they did it from their
// phone, so the timeline never claims a call or text that did not happen.
export async function openCallOrText(kind: 'call' | 'text', phone: string, who: string): Promise<PhoneActionResult> {
  const digits = phone.replace(/[^\d+]/g, '');
  if (!digits) return 'failed';
  if (Platform.OS === 'web') {
    return new Promise<PhoneActionResult>((resolve) => {
      Alert.alert(
        `${kind === 'call' ? 'Call' : 'Text'} ${who}`,
        `${phone.trim()}\n\nA browser can't ${kind === 'call' ? 'place calls' : 'send texts'}. Use your phone, then log it here.`,
        [
          { text: 'Not now', style: 'cancel', onPress: () => resolve('declined') },
          { text: kind === 'call' ? 'I called' : 'I texted', onPress: () => resolve('done') },
        ],
        { cancelable: true, onDismiss: () => resolve('declined') },
      );
    });
  }
  const url = `${kind === 'call' ? 'tel' : 'sms'}:${digits}`;
  try {
    if (!(await Linking.canOpenURL(url))) return 'failed';
    await Linking.openURL(url);
    return 'done';
  } catch {
    return 'failed';
  }
}
