// One check for every free-text field a treatment program reads: the
// placement-request note and the level-of-care override reason. Programs must
// never receive anything that identifies the client or the family, or the
// family's finances. The server runs the same rules (public.identifying_text_
// problem in the migrations) and refuses what this refuses; both test suites
// assert the same cases (scripts/fixtures/identifying-text-cases.json), and a
// differential fuzz compares the two over many generated inputs.
//
// It is a guard, not a guarantee: it catches the common ways details are
// typed, and the screens still tell people to leave them out.
//
// Every pattern runs with the u flag, so a character class or a count reads
// whole characters (as Postgres does), never UTF-16 halves.

export const IDENTIFYING_TEXT_RULES_VERSION = 2;

// Words in a case's title, client label or contact names that are never
// treated as a name. The same list, in the same order, as
// public.identifying_ordinary_words() in the migration (the node test
// compares them). Possessives need no entry of their own: a name is split on
// anything that is not a letter, so "family's" is "family" and "s";
// family's and client's are listed anyway, as written.
const NEVER_A_NAME = new Set([
  // Who someone is to the client: every word of the app's relationship
  // lists (cases.ts CALLER_RELATIONSHIP and the server's
  // lead_caller_relationship, both what is typed and what is saved).
  'self', 'myself', 'himself', 'herself', 'themself', 'themselves',
  'son', 'daughter', 'child', 'kid', 'boy', 'girl', 'stepson', 'stepdaughter', 'stepchild',
  'grandson', 'granddaughter', 'grandchild', 'wife', 'husband', 'spouse', 'partner',
  'boyfriend', 'girlfriend', 'fiance', 'fiancee', 'mom', 'mum', 'mother', 'dad', 'father', 'parent',
  'stepparent', 'grandparent', 'stepdad', 'stepmom', 'stepfather', 'stepmother',
  'grandmother', 'grandfather', 'grandma', 'grandpa', 'brother', 'sister', 'sibling',
  'aunt', 'uncle', 'niece', 'nephew', 'cousin', 'friend', 'best', 'family', 'member',
  'client', 'patient', 'referring', 'professional',
  // The app's own placeholders for a contact or the person a case is about.
  'referent', 'subject', 'loved', 'one',
  // The ordinary words case titles are made of ("Rivera intervention",
  // "Lopez family's first call", "New inquiry - detox").
  'the', 'and', 'for', 'about',
  'intervention', 'interventions', 'placement', 'case', 'lead', 'call', 'calls', 'consult',
  'inquiry', 'referral', 'program', 'treatment', 'rehab', 'detox', 'inpatient', 'outpatient',
  'sober', 'living', 'aftercare', 'recovery', 'new', 'first', 'follow', 'check', 'update',
  'plan', "family's", "client's",
  // What a case title says about the case: substances and kinds of care.
  'alcohol', 'opioid', 'opioids', 'opiate', 'opiates', 'fentanyl', 'heroin', 'meth', 'cocaine',
  'benzo', 'benzos', 'cannabis', 'marijuana', 'gambling', 'drug', 'drugs', 'use', 'relapse',
  'iop', 'php', 'mat', 'dual', 'diagnosis',
]);

// Two-letter words that are everyday words, never a name or initials (Li,
// Wu, Ng and the label's "JR" are). The same list as
// public.identifying_everyday_two().
const EVERYDAY_TWO = new Set([
  'am', 'an', 'as', 'at', 'be', 'by', 'do', 'dr', 'ed', 'er', 'ex', 'go', 'he', 'hi', 'if', 'in', 'is', 'it', 'iv',
  'me', 'mo', 'mr', 'ms', 'my', 'no', 'of', 'oh', 'ok', 'on', 'or', 'pm', 're', 'so', 'to', 'tv', 'up', 'us', 'vs', 'we',
  'de', 'el', 'en', 'es', 'la', 'mi', 'se', 'si', 'te', 'un', 'ya', 'yo',
]);

// Two-letter abbreviations a case title or contact name often carries that
// are not a name: state codes (the app reads a title's state code for the
// match), care shorthand, ordinal endings ("3rd" splits into "rd") and
// units ("16mg"). Al and Ma stay names. Never applied to the client
// label's initials (a label of "TX" means TX). The same list as
// public.identifying_abbreviations().
const ABBREVIATIONS = new Set([
  'ak', 'az', 'ar', 'ca', 'co', 'ct', 'dc', 'fl', 'ga', 'ia', 'id', 'il', 'ks', 'ky', 'md', 'mn', 'mt',
  'nc', 'nd', 'ne', 'nh', 'nj', 'nm', 'nv', 'ny', 'pa', 'pr', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'va',
  'vt', 'wa', 'wi', 'wv', 'wy',
  'aa', 'na', 'rn', 'np', 'pt', 'ot', 'bp', 'hr', 'dx', 'rx', 'hx', 'ua', 'ii', 'st', 'rd', 'th',
  'mg', 'ml', 'kg', 'lb', 'cc', 'mm', 'oz', 'yr', 'wk',
]);

// A month as a whole word or its standard abbreviation (dec, sept, december),
// never the start of a longer word: "decent 12" and "marvel 3" are not dates.
const MONTHS = '(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t)?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)';
// "14 may" is not a date on its own ("2 may help"); "14 May 1985" is.
const MONTHS_NOT_MAY = '(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|june?|july?|aug(ust)?|sep(t)?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)';
const DOMAIN_ENDINGS = '(com|net|org|edu|gov|io|co|me|ly|us|app|info|biz)';
// A real day or month number: "30/60/90" is a program length, not a date.
const DAY = '(0?[1-9]|[12][0-9]|3[01])';
// Between the groups of a phone or ID number: one to three characters that
// are not a digit, a letter or a colon (so a clock time is never one).
const SEP = '[^0-9a-z:]{1,3}';
// A dose range is not a phone number: "100-120 mg".
const NO_UNIT = '(?! *(mg|mcg|ml|cc|g|l|kg|lbs?|units?|mm)(?![a-z]))';

const EMAIL_WORDS = new RegExp(`[a-z0-9]+\\s+(at|\\(at\\)|\\[at\\])\\s+[a-z0-9]+\\s+(dot|\\(dot\\)|\\[dot\\])\\s+${DOMAIN_ENDINGS}(?![a-z0-9])`, 'u');
const DOMAIN = new RegExp(`[a-z0-9-]+\\.${DOMAIN_ENDINGS}(?![a-z0-9])`, 'u');
const DATE_NUMBERS = new RegExp(`(?<![0-9])${DAY}[/.-]${DAY}[/.-]([0-9]{2}|[0-9]{4})(?![0-9])`, 'u');
const DATE_ISO = new RegExp(`(?<![0-9])(19|20)[0-9]{2}[/.-]${DAY}[/.-]${DAY}(?![0-9])`, 'u');
const DATE_MONTH_DAY = new RegExp(`(?<![a-z])${MONTHS}\\.? +[0-9]{1,2}(?![0-9])`, 'u');
const DATE_DAY_MONTH = new RegExp(`(?<![0-9])[0-9]{1,2}(st|nd|rd|th)?( +of)? +${MONTHS_NOT_MAY}(?![a-z])`, 'u');
const DATE_DMY_COMPACT = new RegExp(`(?<![0-9])[0-9]{1,2}[-/.]?${MONTHS}[-/. ]?([0-9]{2}|[0-9]{4})(?![0-9])`, 'u');
const DATE_MDY_COMPACT = new RegExp(`(?<![a-z])${MONTHS}[-/.]?[0-9]{1,2}[-/.]([0-9]{2}|[0-9]{4})(?![0-9])`, 'u');
const PHONE = new RegExp(`(?<![0-9])([0-9]{3}${SEP})?[0-9]{3}${SEP}[0-9]{4}(?![0-9])${NO_UNIT}`, 'u');
const SSN = new RegExp(`(?<![0-9])[0-9]{3}${SEP}[0-9]{2}${SEP}[0-9]{4}(?![0-9])`, 'u');

// Characters that hide or reorder text: C0 and C1 control characters, the
// soft hyphen, the Arabic letter mark, the Mongolian vowel separator, line
// and paragraph separators, zero-width characters, direction overrides and
// isolates, the word joiner and invisible operators, and the byte order mark.
function hasHiddenCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x00ad || code === 0x061c || code === 0x180e || code === 0xfeff) return true;
    if (code === 0x2028 || code === 0x2029) return true;
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2060 && code <= 0x2069) return true;
  }
  return false;
}

// Accents off, then compatibility forms folded and lower case: a name typed
// with or without its accents is one word, and a full-width digit is a digit.
// Letters with a stroke have no accent to take off, so they are spelled out:
// ø ł đ ð ħ ŧ ı read as o l d d h t i.
const STROKE_LETTERS: Record<string, string> = { '\u00f8': 'o', '\u0142': 'l', '\u0111': 'd', '\u00f0': 'd', '\u0127': 'h', '\u0167': 't', '\u0131': 'i' };
function fold(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').normalize('NFKC').toLowerCase()
    .replace(/[\u00f8\u0142\u0111\u00f0\u0127\u0167\u0131]/gu, (char) => STROKE_LETTERS[char]);
}

// Lengths and order as the server counts them: whole characters, not UTF-16
// units, compared by code point (Postgres length() and COLLATE "C").
function characters(value: string): number {
  return Array.from(value).length;
}

function byCodePoint(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index].codePointAt(0) ?? 0) - (b[index].codePointAt(0) ?? 0);
    if (difference) return difference;
  }
  return a.length - b.length;
}

function letterWords(folded: string): string[] {
  return folded.split(/[^\p{L}]+/u).filter(Boolean);
}

// Letter-or-digit tokens, with dotted initials collapsed: "j.r." is "jr",
// "jr." is "jr", "34m" stays "34m". Mirrors public.identifying_tokens.
function tokens(folded: string): string[] {
  const result: string[] = [];
  for (const chunk of folded.split(/[^\p{L}0-9.]+/u)) {
    if (/^\p{L}(\.\p{L})+\.?$/u.test(chunk)) result.push(chunk.replace(/\./gu, ''));
    else result.push(...chunk.split('.'));
  }
  return result.filter(Boolean);
}

// "Calling about: her son" puts a possessive in a lead's case title
// (lead_caller_relationship strips the same words). Right before a
// relationship word it is not a name; anywhere else (the surname Her) it is.
const POSSESSIVE = new RegExp(`(?<!\\p{L})(my|his|her|their|our|your)(?= +(son|daughter|child|kid|boy|girl|stepson|stepdaughter|stepchild|grandson|granddaughter|grandchild|wife|husband|spouse|partner|boyfriend|girlfriend|fiance|fiancee|mom|mum|mother|dad|father|parent|stepparent|grandparent|stepdad|stepmom|stepfather|stepmother|grandmother|grandfather|grandma|grandpa|brother|sister|sibling|aunt|uncle|niece|nephew|cousin|friend|best|loved|family|client|patient)s?(?!\\p{L}))`, 'gu');

// The words of a case title, client label, or contact name that could be a
// name: three or more letters, or two letters that are not an everyday word
// or an abbreviation, and not a word on the never-a-name list.
export function nameWords(values: readonly string[]): string[] {
  const words = new Set<string>();
  for (const value of values) {
    for (const word of letterWords(fold(value).replace(POSSESSIVE, ' '))) {
      const length = characters(word);
      const counts = length >= 3 || (length === 2 && !EVERYDAY_TWO.has(word) && !ABBREVIATIONS.has(word));
      if (counts && !NEVER_A_NAME.has(word)) words.add(word);
    }
  }
  return [...words].sort(byCodePoint);
}

// The client label's own initials and tags, refused as whole words besides
// its name words: tokens of two or more letters or digits with at least one
// letter, dotted initials collapsed ("J.R." is "jr"; "JR 34M" gives "jr" and
// "34m"), never an everyday word or a never-a-name word.
export function labelInitials(label: string | null | undefined): string[] {
  if (!label) return [];
  const result = new Set<string>();
  for (const token of tokens(fold(label))) {
    if (characters(token) >= 2 && /\p{L}/u.test(token) && !EVERYDAY_TWO.has(token) && !NEVER_A_NAME.has(token)) result.add(token);
  }
  return [...result].sort(byCodePoint);
}

// A date: day/month/year with a real day and month, an ISO date, month
// then day, day then month (14th March; "14 may" only with a year), a
// compact date with a year (14-Mar-1985, 14Mar85, Mar-14-1985), dob or born
// (not born-again or born and raised), or a birthday followed by a number.
function mentionsDate(plain: string): boolean {
  return DATE_NUMBERS.test(plain) || DATE_ISO.test(plain) || DATE_MONTH_DAY.test(plain) || DATE_DAY_MONTH.test(plain)
    || DATE_DMY_COMPACT.test(plain) || DATE_MDY_COMPACT.test(plain)
    || /(?<![0-9])[0-9]{1,2}(st|nd|rd|th)?( +of)? +may +[0-9]{2,4}(?![0-9])/u.test(plain)
    || /(?<![a-z])(dob|d\.o\.b\.?|born)(?![a-z])(?![- ]+again(?![a-z])| +and +raised(?![a-z]))/u.test(plain)
    || /(?<![a-z])(birth ?day|b-?day|birth ?date)[^0-9a-z]*((is|on|of|the) +)*[0-9]/u.test(plain);
}

// Five digits in a row (an ID, a zip code, an amount); a phone number (7 or
// 10 digits in groups) that is not a dose range; an SSN; or nine or more
// digits in a row with spaces, dots, brackets or dashes. Clock times, blood
// pressure, year ranges, dose ranges and level lists stay.
function mentionsIdNumber(plain: string): boolean {
  return /[0-9]{5}/u.test(plain) || PHONE.test(plain) || SSN.test(plain) || /[0-9]([ .()_-]{0,3}[0-9]){8,}/u.test(plain);
}

// An amount: thousands with commas, 40k, money words, or an amount in words
// ("40 grand", "forty thousand", "1.5 million"). "Grand" counts only after a
// number: grand mal seizures stay.
function mentionsMoney(plain: string): boolean {
  return /[0-9]{1,3}(,[0-9]{3})+/u.test(plain) || /[0-9]+ ?k(?![a-z])/u.test(plain)
    || /(?<![a-z])(dollars?|usd|budget|afford\w*|out[ -]of[ -]pocket|can pay|cash pay)(?![a-z])/u.test(plain)
    || /[0-9] *(thousand|grand|mil|million)(?![a-z])/u.test(plain)
    || /(?<![a-z])(thousands?|(ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred) +grand)(?![a-z])/u.test(plain);
}

// The alphabetically first name the text carries, or null: a name word as
// a whole word (or its plural, n+s or n+es), or one of the label's initials
// as a whole token.
function nameFound(plain: string, names: readonly string[], label: string | null): string | null {
  const words = new Set(letterWords(plain));
  const found: string[] = nameWords(label ? [...names, label] : names)
    .filter((name) => words.has(name) || words.has(`${name}s`) || words.has(`${name}es`));
  const initials = labelInitials(label);
  if (initials.length) {
    const textTokens = new Set(tokens(plain));
    found.push(...initials.filter((token) => textTokens.has(token)));
  }
  return found.sort(byCodePoint)[0] ?? null;
}

// null when the text is fine; otherwise a short, plain message saying what
// to take out. `names` are the case's own title and contact names; `label`
// is the match's client label (its initials count too). Whole words are
// matched, ignoring case and accents.
export function identifyingTextProblem(text: string, names: readonly string[] = [], label: string | null = null): string | null {
  if (hasHiddenCharacters(text)) return 'Remove line breaks and hidden characters.';
  const plain = fold(text);

  if (plain.includes('@') || EMAIL_WORDS.test(plain)) return 'Leave out email addresses. Programs read this.';
  if (/https?:|www\./u.test(plain) || DOMAIN.test(plain)) return 'Leave out links and web addresses. Programs read this.';
  // Order matters only for which message shows: a currency sign is money,
  // a date pattern is a date, an ID number is a number, and only then are
  // the remaining money patterns checked.
  if (/[$\u20ac\u00a3\u00a5]/u.test(plain)) return 'Leave money out. Programs read this.';
  if (mentionsDate(plain)) return 'Leave out dates such as a birth date. Programs read this.';
  if (mentionsIdNumber(plain)) return 'Leave out phone and ID numbers. Programs read this.';
  if (mentionsMoney(plain)) return 'Leave money out. Programs read this.';
  const found = nameFound(plain, names, label);
  if (found) return `Leave out names ("${found}" is a name on this case). Programs read this.`;
  return null;
}
