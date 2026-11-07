import { registerRootComponent } from 'expo';
import { createElement, Fragment } from 'react';
import { Platform } from 'react-native';

import App from './App';
import { startAppLock } from './src/lib/app-lock';
import { installWebAlert, WebAlertHost } from './src/lib/web-alert';
import { installWebShare } from './src/lib/web-share';

// On the web, Alert.alert and Alert.prompt show an in-page dialog
// (src/lib/web-alert.tsx); WebAlertHost renders it next to the app. Share
// uses the browser's share sheet or the clipboard (src/lib/web-share.ts).
installWebAlert();
installWebShare();

// On iPhone: the app-switcher cover, and "Lock with Face ID" when it is on
// (modules/app-lock), up before the first screen draws.
startAppLock();

function WebRoot() {
  return createElement(Fragment, null, createElement(App), createElement(WebAlertHost));
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(Platform.OS === 'web' ? WebRoot : App);
