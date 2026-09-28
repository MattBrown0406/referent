import { StoreError } from './errors';

// PostgREST caps every response at `max_rows` (1000 in supabase/config.toml)
// and silently drops the rest — no error, no header the client checks. Every
// list read in the data layer goes through fetchAllPages so a growing practice
// never loses rows past that cap.

// Must stay <= max_rows in supabase/config.toml: the loop stops on the first
// short page, so a server cap below PAGE_SIZE would truncate silently again.
export const PAGE_SIZE = 1000;
// Hard safety ceiling (50,000 rows). Past this something is wrong with the
// query shape, and failing loudly beats an unbounded loop or a silent cut-off.
export const MAX_PAGES = 50;

export type PageResult<T> = { data: T[] | null; error: { message: string } | null };
// `query(from, to)` must return the SAME query with `.range(from, to)` applied
// and a deterministic order (an immutable key plus a unique tiebreaker) so
// pages line up.
export type PageQuery<T> = (from: number, to: number) => PromiseLike<PageResult<T>>;

export type PagingOptions<T> = {
  pageSize?: number;
  maxPages?: number;
  // Identity used to drop a row that shifts across a page boundary while a
  // concurrent insert lands. Defaults to `row.id` when present.
  keyOf?: (row: T) => string | undefined;
};

function defaultKey<T>(row: T): string | undefined {
  const id = (row as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : undefined;
}

export async function fetchAllPages<T>(query: PageQuery<T>, options: PagingOptions<T> = {}): Promise<T[]> {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const keyOf = options.keyOf ?? defaultKey;
  const rows: T[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const { data, error } = await query(from, from + pageSize - 1);
    // Rethrow the PostgREST error object untouched so callers keep classifying
    // network failures (offline cache fallback) exactly as before.
    if (error) throw error;
    const chunk = data || [];
    for (const row of chunk) {
      const key = keyOf(row);
      if (key !== undefined) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      rows.push(row);
    }
    if (chunk.length < pageSize) return rows;
  }
  throw new StoreError(
    `This workspace has more than ${maxPages * pageSize} rows in one list, so it could not be loaded completely. Contact support before continuing.`,
    false,
  );
}
