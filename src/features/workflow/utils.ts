let fallbackCounter = 0;

/** UUID-compatible IDs without importing application-domain helpers into this feature. */
export function workflowId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return `${prefix}-${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  fallbackCounter = (fallbackCounter + 1) % 0x1_0000_0000;
  const word = () => Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, '0');
  const hex = `${word()}${word()}${Date.now().toString(16).padStart(12, '0').slice(-12)}${fallbackCounter.toString(16).padStart(8, '0')}`;
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function localDateStamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function canonicalIso(value: string): string | undefined {
  // Reject timezone-ambiguous local date-times: workflow intervals must denote instants.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim())) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

export function validIanaTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0)); return true; } catch { return false; }
}

export function parseMoneyToCents(value: string): number | undefined {
  const normalized = value.trim().replace(/[$,]/g, '');
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return undefined;
  const amount = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

export function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function displayInstant(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}),
    }).format(new Date(iso));
  } catch { return iso; }
}

export function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}
