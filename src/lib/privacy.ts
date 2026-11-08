import { Alert, Linking } from 'react-native';

// ReferralFit's legal and support pages live only on referralfit.com (the
// website repo, MattBrown0406/referralfit-web). App Store Connect's Privacy
// Policy URL and Support URL are these same addresses.
export const PRIVACY_POLICY_URL = 'https://referralfit.com/privacy';
export const TERMS_OF_USE_URL = 'https://referralfit.com/terms';
export const SUPPORT_URL = 'https://referralfit.com/support';

function openPage(url: string, name: string): void {
  Linking.openURL(url).catch(() => {
    Alert.alert(`Could not open the ${name}`, `Open ${url} in your browser.`);
  });
}

export function openPrivacyPolicy(): void {
  openPage(PRIVACY_POLICY_URL, 'privacy policy');
}

export function openTermsOfUse(): void {
  openPage(TERMS_OF_USE_URL, 'terms of use');
}
