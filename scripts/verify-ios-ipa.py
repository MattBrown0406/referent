#!/usr/bin/env python3
import plistlib
import subprocess
import sys
import tempfile
import zipfile
from pathlib import PurePosixPath

if len(sys.argv) != 5:
    raise SystemExit('usage: verify-ios-ipa.py <ipa> <bundle-id> <version> <build-number>')

ipa, expected_bundle, expected_version, expected_build = sys.argv[1:]
with zipfile.ZipFile(ipa) as archive:
    bad = archive.testzip()
    if bad:
        raise SystemExit(f'IPA ZIP integrity failed at {bad}')
    plist_names = [name for name in archive.namelist()
                   if len(PurePosixPath(name).parts) == 3
                   and name.startswith('Payload/') and name.endswith('.app/Info.plist')]
    if len(plist_names) != 1:
        raise SystemExit(f'expected one application Info.plist, found {len(plist_names)}')
    info_name = plist_names[0]
    app_root = info_name.removesuffix('Info.plist')
    info = plistlib.loads(archive.read(info_name))
    signature_name = f'{app_root}_CodeSignature/CodeResources'
    profile_name = f'{app_root}embedded.mobileprovision'
    if signature_name not in archive.namelist() or not archive.read(signature_name):
        raise SystemExit('signed IPA is missing _CodeSignature/CodeResources')
    if profile_name not in archive.namelist() or not archive.read(profile_name):
        raise SystemExit('signed IPA is missing embedded.mobileprovision')
    profile_bytes = archive.read(profile_name)

expected = {
    'CFBundleIdentifier': expected_bundle,
    'CFBundleShortVersionString': expected_version,
    'CFBundleVersion': expected_build,
    'ITSAppUsesNonExemptEncryption': False,
}
for key, value in expected.items():
    if info.get(key) != value:
        raise SystemExit(f'{key} mismatch: expected {value!r}, got {info.get(key)!r}')

with tempfile.NamedTemporaryFile(suffix='.mobileprovision') as profile_file:
    profile_file.write(profile_bytes)
    profile_file.flush()
    decoded = subprocess.run(
        ['openssl', 'smime', '-inform', 'der', '-verify', '-noverify', '-in', profile_file.name],
        check=True, capture_output=True,
    ).stdout
profile = plistlib.loads(decoded)
entitlements = profile.get('Entitlements', {})
application_identifier = entitlements.get('application-identifier', '')
if not application_identifier.endswith(f'.{expected_bundle}'):
    raise SystemExit(f'provisioning application-identifier mismatch: {application_identifier!r}')
if entitlements.get('get-task-allow') is not False:
    raise SystemExit('provisioning profile is not a release profile (get-task-allow must be false)')
if entitlements.get('beta-reports-active') is not True:
    raise SystemExit('provisioning profile is not enabled for TestFlight beta reports')

print('ipa_identity=PASS')
print('ipa_signature_resources=PASS')
print('provisioning_profile=PASS')
for key in expected:
    print(f'{key}={info.get(key)}')
