// The pure part of family-assessment-upload: reading the request. See index.ts.

export class UploadRequestError extends Error {}

export type UploadRequest = { token: string; side: 'front' | 'back' };

export function parseUploadRequest(body: unknown): UploadRequest {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const token = typeof input.token === 'string' ? input.token.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) throw new UploadRequestError('This link is not complete. Open it again from the email.');
  const side = input.side === 'front' || input.side === 'back' ? input.side : null;
  if (!side) throw new UploadRequestError('Choose the front or the back of the card.');
  return { token, side };
}
