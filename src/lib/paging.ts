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
// A list that legitimately grows past it (touches) passes its own maxPages.
export const MAX_PAGES = 50;

// A list too long to load completely (the ceiling above), or a server that
// kept answering with rows it had already sent. The read did not finish, so
// nothing it returned may replace a saved copy: callers fall back to the
// cache (store.ts hydrate) instead of failing the launch.
export class PagingLimitError extends StoreError {
  constructor(message: string) {
    super(message, false);
    this.name = 'PagingLimitError';
  }
}

export function isPagingLimitError(error: unknown): boolean {
  return error instanceof PagingLimitError || (error as { name?: unknown } | null)?.name === 'PagingLimitError';
}

export type PageResult<T> = { data: T[] | null; error: { message: string } | null; status?: number };
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
    const { data, error, status } = await query(from, from + pageSize - 1);
    // Rethrow the PostgREST error object (not a copy, not a StoreError) so
    // callers keep classifying it (offline / passing server failure → cache
    // fallback). The HTTP status rides along so a gateway's 5xx page is
    // recognisable (errors.ts isTransientServerError).
    if (error) {
      if (typeof status === 'number' && typeof error === 'object') Object.assign(error, { httpStatus: status });
      throw error;
    }
    const chunk = data || [];
    let added = 0;
    for (const row of chunk) {
      const key = keyOf(row);
      if (key !== undefined) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      rows.push(row);
      added += 1;
    }
    if (chunk.length < pageSize) return rows;
    // A full page of rows already seen: the server is ignoring the range.
    // Looping on would never end (or end only at the ceiling, much later).
    if (page > 0 && added === 0) {
      throw new PagingLimitError('The server returned the same rows again while loading a list, so it could not be loaded completely. Pull down to try again.');
    }
  }
  throw new PagingLimitError(
    `This workspace has more than ${maxPages * pageSize} rows in one list, so it could not be loaded completely. Contact support before continuing.`,
  );
}
