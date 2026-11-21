// The name under ReferralFit's icon in the iOS share sheet. expo-share-intent
// names its extension "<app name> - Share Extension" unless it is given a
// name, and the name it is given also becomes the extension's Xcode target
// name, which cannot be "ReferralFit" (the app's own target). So the target
// keeps the plugin's default name, ShareExtension, and this sets only the
// name people see, after the plugin has written the extension's Info.plist.
// docs/DAY_REVIEW.md ("Share to ReferralFit, as built").
const fs = require('node:fs');
const path = require('node:path');
const plist = require('@expo/plist').default;
const { withFinalizedMod } = require('expo/config-plugins');

const EXTENSION_FOLDER = 'ShareExtension';
const INFO_PLIST = 'ShareExtension-Info.plist';

module.exports = function withShareExtensionName(config, { displayName } = {}) {
  return withFinalizedMod(config, ['ios', async (modConfig) => {
    const name = displayName || modConfig.name;
    const file = path.join(modConfig.modRequest.platformProjectRoot, EXTENSION_FOLDER, INFO_PLIST);
    if (!fs.existsSync(file)) {
      throw new Error(`[share-extension-name] ${file} is missing: is expo-share-intent listed before this plugin in app.json?`);
    }
    const info = plist.parse(fs.readFileSync(file, 'utf8'));
    info.CFBundleDisplayName = name;
    fs.writeFileSync(file, plist.build(info));
    return modConfig;
  }]);
};
