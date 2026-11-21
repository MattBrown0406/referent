// Share to ReferralFit: text or a link shared from any app (Messages, Mail,
// Notes, Voice Memos, a recorder's app) through the iOS share extension
// (expo-share-intent, app.json). What arrives goes into the Review notes box,
// added below anything already typed there, and waits for the practitioner to
// tap Find: nothing is sent to the AI on its own. Pure rules here; App.tsx
// receives the share and DayReviewSheet.tsx takes it. docs/DAY_REVIEW.md
// ("Share to ReferralFit and voice notes, as built").

/** The most one review reads (LIMITS.textMax in supabase/functions/day-review/review.ts). */
export const REVIEW_TEXT_MAX = 12_000;

/** A shared .txt file larger than this is not read (it could not be reviewed in one go anyway). */
export const SHARED_FILE_MAX_BYTES = 512 * 1024;

/** What expo-share-intent hands over (its ShareIntent), as far as these rules read it. */
export type SharedPayload = {
  text?: string | null;
  webUrl?: string | null;
  meta?: { title?: string | null } | null;
  files?: { path: string | null; mimeType?: string | null; fileName?: string | null; size?: number | null }[] | null;
  type?: string | null;
};

export type SharedFileText = { name: string; text: string };

export type SharedNote = {
  /** For the notes box, already capped at REVIEW_TEXT_MAX. */
  text: string;
  /** Longer than one review reads: the end was cut off. */
  trimmed: boolean;
  kind: 'text' | 'link' | 'file';
};

const NUMBER = new Intl.NumberFormat('en-US');

/** Line ends made plain, control characters (other than tab and new line) removed, outer space trimmed. */
export function cleanSharedText(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** A title or file name for the "Shared from" line: one line, not too long. */
function label(value: string | null | undefined, max = 120): string {
  const line = cleanSharedText(value).replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Plain text files only (a .txt, or a file the sending app calls text/plain), and not huge ones. */
export function isTextFile(file: NonNullable<SharedPayload['files']>[number]): boolean {
  if (!file?.path) return false;
  const mime = (file.mimeType || '').toLowerCase();
  const name = (file.fileName || file.path).toLowerCase();
  const plain = mime === 'text/plain' || mime.startsWith('text/plain;') || /\.txt$/.test(name);
  return plain && !(typeof file.size === 'number' && file.size > SHARED_FILE_MAX_BYTES);
}

/**
 * At most `max` characters, cut at the last space or line end near the limit
 * when there is one, so the box does not end in half a word.
 */
export function capForReview(text: string, max = REVIEW_TEXT_MAX): { text: string; trimmed: boolean } {
  if (text.length <= max) return { text, trimmed: false };
  let cut = text.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  if (lastBreak > max - 300) cut = cut.slice(0, lastBreak);
  return { text: cut.trimEnd(), trimmed: true };
}

const URL_ONLY = /^https?:\/\/\S+$/i;

/**
 * The text a share puts in the notes box, with a line saying where it came
 * from when that is known (a web page's title, a file's name). iOS does not
 * tell an app which app shared to it, so plain text has no such line.
 * Null when nothing in the share can be read (a photo, a PDF).
 */
export function sharedNote(payload: SharedPayload | null | undefined, fileTexts: SharedFileText[] = []): SharedNote | null {
  if (!payload) return null;
  const text = cleanSharedText(payload.text);
  const webUrl = cleanSharedText(payload.webUrl);
  const title = label(payload.meta?.title);
  let body = '';
  let kind: SharedNote['kind'] = 'text';
  if (text && !(URL_ONLY.test(text) && (!webUrl || text === webUrl))) {
    body = title ? `Shared from ${title}:\n${text}` : text;
  } else if (text || webUrl) {
    kind = 'link';
    const url = webUrl || text;
    body = title ? `Shared link: ${title}\n${url}` : `Shared link:\n${url}`;
  } else {
    const files = fileTexts
      .map((file) => ({ name: label(file.name), text: cleanSharedText(file.text) }))
      .filter((file) => file.text);
    if (!files.length) return null;
    kind = 'file';
    body = files.map((file) => (file.name ? `Shared from ${file.name}:\n${file.text}` : file.text)).join('\n\n');
  }
  const capped = capForReview(body);
  return { text: capped.text, trimmed: capped.trimmed, kind };
}

/** Shared text goes below what is already in the box; it never replaces typed notes. */
export function appendToNotes(current: string, addition: string): string {
  const before = current.trimEnd();
  return before.trim() ? `${before}\n\n${addition}` : addition;
}

/** What the sheet says once the shared text is in the box. */
export function sharedNoteMessage(note: Pick<SharedNote, 'kind' | 'trimmed'>, { appended, totalLength }: { appended: boolean; totalLength: number }): string {
  const parts = [
    appended
      ? 'What you shared is in the box, below the notes that were already there.'
      : 'What you shared is in the box.',
    note.kind === 'link'
      ? 'ReferralFit reads only the words in the box, not the page the link opens: add what matters from it.'
      : 'Check it, then tap Find what\'s in it.',
  ];
  if (note.trimmed) {
    parts.push(`Only the first ${NUMBER.format(REVIEW_TEXT_MAX)} characters were kept: that is the most one review reads. Share the rest after this review.`);
  } else if (totalLength > REVIEW_TEXT_MAX) {
    parts.push(`The box now holds more than one review reads (${NUMBER.format(REVIEW_TEXT_MAX)} characters). Review part of it, then the rest.`);
  }
  return parts.join(' ');
}

/** The same share delivered twice (iOS can hand it over on open and on return): one key. */
export function shareKey(payload: SharedPayload): string {
  return JSON.stringify([
    payload.type || '',
    payload.text || '',
    payload.webUrl || '',
    (payload.files || []).map((file) => `${file?.fileName || ''}:${file?.size ?? ''}`),
  ]);
}

export const SHARE_UNREADABLE_MESSAGE =
  'ReferralFit takes text and links from other apps, not photos or other files. Copy the words you want and share those, or paste them in Review notes.';
