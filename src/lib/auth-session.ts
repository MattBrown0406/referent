import { decode } from 'base64-arraybuffer';

import { supabase } from './supabase';

export type AuthSessionIdentity = { userId: string; sessionId: string };

function jwtSessionId(accessToken: string): string | null {
  try {
    const segment = accessToken.split('.')[1];
    if (!segment) return null;
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const bytes = new Uint8Array(decode(padded));
    const json = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    const payload = JSON.parse(json) as { session_id?: unknown };
    return typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
  } catch {
    return null;
  }
}

// Supabase's session_id JWT claim is stable across access-token refreshes but
// changes for a genuine sign-out/re-login, including a new login to the same
// user UUID. That makes it the correct login-epoch fence for asynchronous work.
export async function currentAuthSessionIdentity(): Promise<AuthSessionIdentity | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.user.id) return null;
  const sessionId = jwtSessionId(data.session.access_token);
  if (!sessionId) return null;
  return { userId: data.session.user.id.toLowerCase(), sessionId };
}
