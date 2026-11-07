# Lock with Face ID, and the app-switcher cover (iPhone)

Workspace → **Privacy on this phone**. Per phone, off by default.

- **The cover.** Whenever ReferralFit stops being the active app (the app
  switcher, Control Center, a call), a plain ReferralFit screen covers it, so
  the switcher's snapshot never shows a case. Always on; no setting.
- **The lock.** When on, ReferralFit asks for Face ID (Touch ID, Optic ID;
  the iPhone's passcode always works too) at launch, and when the person comes
  back after the chosen time away: every time, after 1 minute (the default) or
  after 5 minutes. Turning it on asks for Face ID first, so it is never on for
  someone who cannot open it. If the iPhone's passcode is later removed, the
  lock turns itself off at the next unlock instead of shutting the person out.

## How it works

`modules/app-lock` is a local Expo module (Swift, no third-party code). The
cover is a `UIWindow` of its own at alert level + 1: a React view cannot
cover a sheet that is already open (React Native presents each sheet from the
view controller below it), and an alert raised while locked would otherwise
land on top. The setting is in `UserDefaults`, read when the module starts
(`index.ts` → `startAppLock()`), so the lock is up before the first screen
draws. Time away is measured by uptime, so changing the clock does not skip
it. Face ID's own sheet makes the app inactive and active again; that never
re-triggers the lock, and after a cancel the lock waits for the Unlock
button instead of prompting in a loop.

The web app has no lock; the card is hidden there. `NSFaceIDUsageDescription`
comes from the `expo-secure-store` plugin in `app.json` (`faceIDPermission`).

## Checking it on a simulator

Local builds with Xcode 27 need an iOS 26 simulator: the iOS 27 SDK refuses
to launch an app that has not adopted the UIScene lifecycle, and Expo's
generated app has not. EAS builds use Xcode 26.6 (`eas.json`), so this does
not affect real builds.

```sh
xcrun simctl spawn <udid> notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
xcrun simctl spawn <udid> notifyutil -p com.apple.BiometricKit.enrollmentChanged   # enrol Face ID
xcrun simctl spawn <udid> notifyutil -p com.apple.BiometricKit_Sim.pearl.match     # a matching face
xcrun simctl spawn <udid> notifyutil -p com.apple.BiometricKit_Sim.pearl.nomatch   # a different face
```

Checked 2026-11-06 on an iPhone 17 simulator (iOS 26.5): locked at launch
with the prompt up; the switcher shows only the cover with a sheet open;
back from the home screen with "every time" it locks above the open sheet;
a different face, then Cancel, leaves it locked with the Unlock button; a
match unlocks with the sheet as it was; turning it on asks for Face ID and
the cover comes down after. Simulated taps on iOS 26 switches need a press
of about 0.2 s; quicker ones do not register.
