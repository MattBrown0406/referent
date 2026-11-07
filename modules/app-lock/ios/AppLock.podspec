Pod::Spec.new do |s|
  s.name           = 'AppLock'
  s.version        = '1.0.0'
  s.summary        = 'ReferralFit app lock and app-switcher privacy cover'
  s.description    = 'Covers the app in its own window when it stops being active, and locks it behind Face ID or the passcode.'
  s.license        = 'UNLICENSED'
  s.author         = 'ReferralFit'
  s.homepage       = 'https://referralfit.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'LocalAuthentication'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
