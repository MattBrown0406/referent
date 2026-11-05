// One check for every free-text field a treatment program reads: the
// placement-request note and the level-of-care override reason. Programs must
// never receive anything that identifies the client or the family, or the
// family's finances. The server runs the same rules (public.identifying_text_
// problem in the migrations) and refuses what this refuses; both test suites
// assert the same cases (scripts/fixtures/identifying-text-cases.json).
//
// It is a guard, not a guarantee: it catches the common ways details are
// typed, and the screens still tell people to leave them out.

export const IDENTIFYING_TEXT_RULES_VERSION = 1;

// Words in a case's own title or contact names that say who someone is to the
// client, not who they are. They are never treated as a name.
const RELATIONSHIP_WORDS = new Set([
  'son', 'daughter', 'child', 'kid', 'boy', 'girl', 'wife', 'husband', 'spouse', 'partner',
  'mom', 'mum', 'mother', 'dad', 'father', 'parent', 'brother', 'sister', 'sibling',
  'grandson', 'granddaughter', 'grandmother', 'grandfather', 'aunt', 'uncle', 'niece',
  'nephew', 'cousin', 'friend', 'family', 'client', 'self', 'the', 'and', 'for', 'about',
  'stepson', 'stepdaughter', 'boyfriend', 'girlfriend', 'fiance', 'fiancee',
]);

const MONTHS = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const DOMAIN_ENDINGS = '(com|net|org|edu|gov|io|co|me|ly|us|app|info|biz)';

// Characters that hide or reorder text: control characters, line and
// paragraph separators, zero-width characters, and direction overrides.
function hasHiddenCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
    if (code === 0x2028 || code === 0x2029) return true;
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
  }
  return false;
}

// The words of a case title, client label, or contact name that could be a
// name: three or more letters, not a relationship word.
export function nameWords(values: string[]): string[] {
  const words = new Set<string>();
  for (const value of values) {
    for (const word of value.normalize('NFKC').toLowerCase().split(/[^\p{L}]+/u)) {
      if (word.length >= 3 && !RELATIONSHIP_WORDS.has(word)) words.add(word);
    }
  }
  return [...words];
}

// null when the text is fine; otherwise a short, plain message saying what
// to take out. `names` are the case's own title, client label, and contact
// names (whole words are matched, ignoring case).
export function identifyingTextProblem(text: string, names: string[] = []): string | null {
  if (hasHiddenCharacters(text)) return 'Remove line breaks and hidden characters.';
  const plain = text.normalize('NFKC').toLowerCase();

  if (plain.includes('@') || new RegExp(`[a-z0-9]+\\s+(at|\\(at\\)|\\[at\\])\\s+[a-z0-9]+\\s+(dot|\\(dot\\)|\\[dot\\])\\s+${DOMAIN_ENDINGS}(?![a-z0-9])`).test(plain)) {
    return 'Leave out email addresses. Programs read this.';
  }
  if (/https?:|www\./.test(plain) || new RegExp(`[a-z0-9-]+\\.${DOMAIN_ENDINGS}(?![a-z0-9])`).test(plain)) {
    return 'Leave out links and web addresses. Programs read this.';
  }
  // Order matters only for which message shows: a currency sign is money,
  // a date pattern is a date, six or more digits are a phone or ID number,
  // and only then are the remaining money patterns checked.
  if (/[$€£¥]/.test(plain)) return 'Leave money out. Programs read this.';
  if (/(?<![0-9])[0-9]{1,2}[/.-][0-9]{1,2}[/.-][0-9]{2,4}(?![0-9])/.test(plain)
    || new RegExp(`(?<![a-z])${MONTHS}\\.? +[0-9]{1,2}(?![0-9])`).test(plain)
    || /(?<![a-z])(dob|d\.o\.b\.?|born)(?![a-z])/.test(plain)) {
    return 'Leave out dates such as a birth date. Programs read this.';
  }
  if (/[0-9]([^0-9a-z]{0,3}[0-9]){5,}/.test(plain)) {
    return 'Leave out phone and ID numbers. Programs read this.';
  }
  if (/[0-9]{1,3}(,[0-9]{3})+/.test(plain) || /[0-9]+ ?k(?![a-z])/.test(plain)
    || /(?<![a-z])(dollars?|usd|budget|afford\w*|out[ -]of[ -]pocket|can pay|cash pay)(?![a-z])/.test(plain)) {
    return 'Leave money out. Programs read this.';
  }
  const words = new Set(plain.split(/[^\p{L}]+/u).filter(Boolean));
  for (const name of nameWords(names)) {
    if (words.has(name)) return 'Leave out names. Programs read this.';
  }
  return null;
}
