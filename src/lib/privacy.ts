import { Alert, Linking } from 'react-native';

// The published privacy policy (docs/privacy.html, served by GitHub Pages).
// App Store Connect's Privacy Policy URL must be this same address.
export const PRIVACY_POLICY_URL = 'https://mattbrown0406.github.io/referent/privacy.html';

export function openPrivacyPolicy(): void {
  Linking.openURL(PRIVACY_POLICY_URL).catch(() => {
    Alert.alert('Could not open the privacy policy', `Open ${PRIVACY_POLICY_URL} in your browser.`);
  });
}
