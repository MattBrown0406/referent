// The pure part of family-assessment-upload: reading the request and naming
// each upload. See index.ts.

export class UploadRequestError extends Error {}

export type UploadRequest =
  | { action: 'sign'; token: string; side: 'front' | 'back' }
  | { action: 'done'; token: string; side: 'front' | 'back'; path: string };

const PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/card-(front|back)-[0-9a-f]{32}$/;

export function parseUploadRequest(body: unknown): UploadRequest {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const token = typeof input.token === 'string' ? input.token.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) throw new UploadRequestError('This link is not complete. Open it again from the email.');
  const side = input.side === 'front' || input.side === 'back' ? input.side : null;
  if (!side) throw new UploadRequestError('Choose the front or the back of the card.');
  if (input.action === undefined || input.action === 'sign') return { action: 'sign', token, side };
  if (input.action !== 'done') throw new UploadRequestError('The request could not be read.');
  const path = typeof input.path === 'string' ? input.path : '';
  if (!PATH.test(path) || !path.includes(`/card-${side}-`)) throw new UploadRequestError('The photo could not be matched. Choose it again.');
  return { action: 'done', token, side, path };
}

/**
 * A new name for one upload: <case>/<assessment>/card-<side>-<32 hex>.
 * Every photo gets its own, so an upload that finishes late (after the
 * assessment was sent, or after a newer photo) can never replace the photo
 * the practitioner has: only the name the database recorded is shown.
 */
export function uploadName(prefix: string, random: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
  return `${prefix}-${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
