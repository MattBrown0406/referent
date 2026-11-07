import { Platform, useWindowDimensions } from 'react-native';
import type { ViewStyle } from 'react-native';

// The web app (app.referralfit.com) runs the same screens as the iPhone app.
// In a browser, page sheets read as a centered document column and bottom
// sheets as centered cards; from WIDE_WEB_MIN_WIDTH up, App.tsx swaps the
// bottom tabs for a sidebar. Every style here is null on a phone.

export const IS_WEB = Platform.OS === 'web';

// A browser window wide enough for the sidebar layout.
export const WIDE_WEB_MIN_WIDTH = 960;

export function useWideWeb(): boolean {
  const { width } = useWindowDimensions();
  return IS_WEB && width >= WIDE_WEB_MIN_WIDTH;
}

// A pageSheet's page (the case file, every form): a centered column.
export const WEB_PAGE: ViewStyle | null = IS_WEB
  ? { width: '100%', maxWidth: 820, alignSelf: 'center', borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#DDE4DF' }
  : null;

// A bottom sheet's backdrop and card: centered, with every corner rounded.
export const WEB_SHEET_OVERLAY: ViewStyle | null = IS_WEB
  ? { justifyContent: 'center', alignItems: 'center', padding: 16 }
  : null;

export const WEB_SHEET: ViewStyle | null = IS_WEB
  ? { width: '100%', maxWidth: 560, borderRadius: 22 }
  : null;
