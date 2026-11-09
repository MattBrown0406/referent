// Shared pieces of the ai-assist function: the user's own Anthropic key,
// text cleaning, and comparing text loosely. Pure, so the tests cover them.
// See docs/MATCH_EXPLANATION.md and docs/FAMILY_ASSESSMENT.md.

export class AssistRequestError extends Error {}
export class AssistOutputError extends Error {}

// Each practitioner brings their own Anthropic API key, exactly as for AI
// drafts and day review: it arrives in the request body, is used for that
// one call, and is never stored or logged.
const ANTHROPIC_KEY = /^sk-ant-[A-Za-z0-9_-]{20,250}$/;

export function parseApiKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return ANTHROPIC_KEY.test(key) ? key : null;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Collapse whitespace, drop control characters, cap the length. */
export function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Letters and digits only, lower case, single spaces. */
export function comparable(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The numbers written in a text ("$4,500" is 4500), to check a rewrite adds none. */
export function numbersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    found.add(match[0].replace(/,/g, '').replace(/\.0+$/, ''));
  }
  return found;
}

/** Text that looks like the tags around the data is changed, so data cannot appear to end early. */
export function fenced(text: string, tag: string): string {
  return text.replace(new RegExp(`<\\s*/?\\s*${tag}\\s*>`, 'gi'), `(${tag})`);
}
