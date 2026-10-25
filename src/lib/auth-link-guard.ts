import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AuthFlowKind, AuthFlowStarts } from './auth-flows';

// When this device last started a sign-up or a password reset (LoginScreen).
// App.tsx accepts tokens from a referralfit://auth/... link only for a flow
// started here in the last 24 hours (decideAuthLink in auth-flows.ts), and
// clears the record once a link has been used. Device-wide, not per account:
// nobody is signed in yet when these flows start.
const AUTH_FLOW_STARTS_KEY = 'referralfit.authFlowStarts.v1';

export async function readAuthFlowStarts(): Promise<AuthFlowStarts> {
  try {
    const raw = await AsyncStorage.getItem(AUTH_FLOW_STARTS_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const starts: AuthFlowStarts = {};
    for (const kind of ['signup', 'recovery'] as AuthFlowKind[]) {
      if (typeof parsed[kind] === 'number') starts[kind] = parsed[kind] as number;
    }
    return starts;
  } catch {
    return {};
  }
}

async function writeAuthFlowStarts(starts: AuthFlowStarts): Promise<void> {
  await AsyncStorage.setItem(AUTH_FLOW_STARTS_KEY, JSON.stringify(starts));
}

// Best effort: a storage failure must never block sign-up or a reset. The
// link then asks the user to sign in instead of signing them in by itself.
export async function recordAuthFlowStart(kind: AuthFlowKind, now = Date.now()): Promise<void> {
  try {
    await writeAuthFlowStarts({ ...await readAuthFlowStarts(), [kind]: now });
  } catch {
    // ignored: see above
  }
}

// A link for this flow was used: the next one needs a fresh start.
export async function clearAuthFlowStart(kind: AuthFlowKind): Promise<void> {
  try {
    const starts = await readAuthFlowStarts();
    delete starts[kind];
    await writeAuthFlowStarts(starts);
  } catch {
    // ignored: the record expires after 24 hours anyway
  }
}
