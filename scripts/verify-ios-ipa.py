#!/usr/bin/env python3
import plistlib
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


def nm_symbols(binary, *flags):
    output = subprocess.run(
        ['/usr/bin/nm', *flags, str(binary)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return {
        line.split()[-1]
        for line in output.splitlines()
        if line.strip()
    }


def verify_expo_module_links(framework_binaries):
    core_name = 'ExpoModulesCore'
    if core_name not in framework_binaries:
        raise SystemExit('signed IPA is missing ExpoModulesCore.framework')

    with tempfile.TemporaryDirectory(prefix='referralfit-ipa-frameworks-') as temp_dir:
        binary_paths = {}
        for framework_name, binary_bytes in framework_binaries.items():
            binary_path = Path(temp_dir) / framework_name
            binary_path.write_bytes(binary_bytes)
            binary_path.chmod(0o755)
            binary_paths[framework_name] = binary_path

        core_exports = nm_symbols(binary_paths[core_name], '-gU')
        missing_by_framework = {}
        symbol_prefixes = ('_$s15ExpoModulesCore', '$s15ExpoModulesCore')
        for framework_name, binary_path in binary_paths.items():
            if framework_name == core_name:
                continue
            imports = {
                symbol
                for symbol in nm_symbols(binary_path, '-u')
                if symbol.startswith(symbol_prefixes)
            }
            missing = sorted(imports - core_exports)
            if missing:
                missing_by_framework[framework_name] = missing

    if missing_by_framework:
        details = []
        for framework_name, symbols in sorted(missing_by_framework.items()):
            details.append(
                f'{framework_name}.framework imports symbols absent from '
                f'ExpoModulesCore.framework: {", ".join(symbols)}'
            )
        raise SystemExit('Expo native framework link check failed:\n' + '\n'.join(details))

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
    frameworks_root = PurePosixPath(app_root) / 'Frameworks'
    framework_binaries = {}
    for name in archive.namelist():
        path = PurePosixPath(name)
        if (
            path.parent.parent == frameworks_root
            and path.parent.suffix == '.framework'
            and path.name == path.parent.stem
        ):
            framework_binaries[path.parent.stem] = archive.read(name)

expected = {
    'CFBundleIdentifier': expected_bundle,
    'CFBundleShortVersionString': expected_version,
    'CFBundleVersion': expected_build,
    'ITSAppUsesNonExemptEncryption': False,
}
for key, value in expected.items():
    if info.get(key) != value:
        raise SystemExit(f'{key} mismatch: expected {value!r}, got {info.get(key)!r}')

verify_expo_module_links(framework_binaries)

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
print('expo_module_links=PASS')
print('provisioning_profile=PASS')
for key in expected:
    print(f'{key}={info.get(key)}')
