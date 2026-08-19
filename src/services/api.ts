import type { TrendLabel } from '@/types/asset';

export type StockQuote = {
  // Multi-Currency engine: normalized to USD by the backend — this is the
  // ONLY field allocation math (portfolio totals, layer percentages,
  // drawdowns, trailing stops) may ever use, so a Shekel-quoted TASE
  // position and a Dollar-quoted US one can be summed together correctly.
  price: number;
  // The instrument's own actual local-currency value (e.g. 13.48) and the
  // symbol to display it with ('$' or '₪') — for on-screen display only,
  // never for math. See StockCard/PortfolioStockRow.
  localPrice: number;
  currencySymbol: string;
  // Yahoo Finance doesn't always publish these for every instrument (e.g. a
  // very newly listed ticker), so the backend passes that absence through
  // as null rather than failing the whole request. Returned for EVERY
  // asset now (Portfolio included, not just Ambush Radar — see
  // backend/main.py's get_stock), since MomentumBar (see
  // @/components/MomentumBar) is now shared by both screens.
  sma50: number | null;
  sma200: number | null;
  // TREND CLASSIFICATION: two independent signals computed backend-side
  // (see backend/main.py's _classify_trend) — macroTrend is price vs.
  // SMA200 (the long-term trend), tacticalMomentum is price vs. SMA50 (the
  // finer-grained momentum signal). Replaces the old single, asset-type-
  // dependent Bullish/Bearish verdict this app used to compute client-side
  // (SMA200 for ETFs, SMA50 for Stocks — silently hiding whichever signal
  // it didn't pick). null when the underlying SMA itself is unavailable,
  // same as sma50/sma200 above — never a guessed default.
  macroTrend: TrendLabel;
  tacticalMomentum: TrendLabel;
  // Present when the backend's Anomaly News Fetcher detects a same-day
  // move of 4%+ and finds explanatory headlines; null otherwise (no
  // notable move, or no news found).
  anomalyReport: string | null;
  // Yahoo's official 52-week high (accounts for intraday highs, not just
  // closing prices) and the current price's drawdown from it as a
  // negative percentage (0 = at the high). Null if Yahoo doesn't publish
  // a 52-week high for this instrument.
  high52: number | null;
  drawdownPct: number | null;
};

export type TickerSearchResult = {
  symbol: string;
  shortname: string;
  exchDisp: string;
};

export type IntelArticle = {
  title: string;
  publisher: string;
  publishedAt: string;
  link: string;
  isCritical: boolean;
  tag: string;
};

export type IntelTickerResult = {
  ticker: string;
  news: IntelArticle[];
  // Set when this specific ticker's fetch failed; the rest of the batch
  // (see IntelBatchResponse.results) is unaffected — the backend isolates
  // per-ticker failures rather than failing the whole request.
  error?: string;
};

export type IntelBatchResponse = {
  results: IntelTickerResult[];
};

// Production FastAPI backend (see /backend), deployed on Render.
const API_BASE_URL = 'https://pipeline-app-1a68.onrender.com';

// Concurrency ceiling for fetchInChunks below: a Promise.all()/allSettled()
// over an entire watchlist fires every request at once — for a portfolio
// of a dozen-plus tickers that's a dozen-plus simultaneous connections,
// which overwhelms slower/cellular connections and trips request timeouts
// long before any individual ticker fetch would time out on its own.
const DEFAULT_CHUNK_SIZE = 4;

// Processes `items` through `fetchItem` in fixed-size concurrent batches —
// never more than `chunkSize` requests in flight at once — awaiting each
// batch fully before starting the next. Returns one PromiseSettledResult
// per item, in the same order as `items`, so this is a drop-in replacement
// for `Promise.allSettled(items.map(fetchItem))`: existing
// `results.forEach((result, index) => ...)` call sites work unchanged.
// Callers that need the loading state to reflect "everything resolved"
// (not just one batch) should simply await the whole call, same as they
// already await Promise.allSettled — the returned promise doesn't settle
// until every batch, not just the first, has completed.
export async function fetchInChunks<TItem, TResult>(
  items: TItem[],
  fetchItem: (item: TItem) => Promise<TResult>,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<PromiseSettledResult<TResult>[]> {
  const results: PromiseSettledResult<TResult>[] = [];

  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    const chunkResults = await Promise.allSettled(chunk.map(fetchItem));
    results.push(...chunkResults);
  }

  return results;
}

export async function fetchStockData(ticker: string): Promise<StockQuote> {
  const normalizedTicker = ticker.trim().toUpperCase();

  let response: Response;
  try {
    // include_anomaly=true opts into the backend's Anomaly News Fetcher
    // (an extra, throttled Yahoo call on their side) for every quote fetch.
    response = await fetch(`${API_BASE_URL}/api/stock/${normalizedTicker}?include_anomaly=true`);
  } catch {
    throw new Error(
      `Could not reach the Pipeline API at ${API_BASE_URL}. Check that the backend is running and that your device is on the same network.`,
    );
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errorBody = (await response.json()) as { detail?: string };
      detail = errorBody.detail ?? detail;
    } catch {
      // Response body was not valid JSON; fall back to the status text.
    }
    throw new Error(`Failed to fetch data for ${normalizedTicker}: ${detail}`);
  }

  const data = (await response.json()) as {
    price?: number;
    anomaly?: string | null;
    high_52?: number | null;
    drawdown_pct?: number | null;
    local_price?: number | null;
    currency_symbol?: string | null;
    // Backend field names, snake_case with an underscore — matching every
    // other multi-word key in this response (local_price, high_52,
    // drawdown_pct). Deliberately distinct from this file's own camelCase
    // sma50/sma200/macroTrend/tacticalMomentum StockQuote fields below,
    // same as every other field in this raw-JSON shape.
    sma_50?: number | null;
    sma_200?: number | null;
    macro_trend?: string | null;
    tactical_momentum?: string | null;
  };

  if (typeof data.price !== 'number') {
    throw new Error(`Received malformed data for ${normalizedTicker}.`);
  }

  return {
    price: data.price,
    // Fall back to the USD price / '$' if an older backend response
    // doesn't include these yet, rather than throwing — display-only
    // fields degrading gracefully is preferable to breaking the fetch.
    localPrice: typeof data.local_price === 'number' ? data.local_price : data.price,
    currencySymbol: typeof data.currency_symbol === 'string' ? data.currency_symbol : '$',
    sma50: typeof data.sma_50 === 'number' ? data.sma_50 : null,
    sma200: typeof data.sma_200 === 'number' ? data.sma_200 : null,
    macroTrend: parseTrendLabel(data.macro_trend),
    tacticalMomentum: parseTrendLabel(data.tactical_momentum),
    anomalyReport: typeof data.anomaly === 'string' ? data.anomaly : null,
    high52: typeof data.high_52 === 'number' ? data.high_52 : null,
    drawdownPct: typeof data.drawdown_pct === 'number' ? data.drawdown_pct : null,
  };
}

// TREND CLASSIFICATION: validates the backend's macro_trend/
// tactical_momentum strings into the TrendLabel union rather than trusting
// them as-is — anything other than exactly 'Bullish'/'Bearish' (missing,
// null, or an unexpected value from a future backend change) degrades to
// null ("can't be evaluated"), never a guessed default.
function parseTrendLabel(value: string | null | undefined): TrendLabel {
  return value === 'Bullish' || value === 'Bearish' ? value : null;
}

// On-Demand Intel V3.1: latest news for one or more comma-separated
// tickers (e.g. "PLD, UNH, AMT"), regardless of whether they moved today.
// tickersInput is sent as-is (URL-encoded) — the backend does the actual
// splitting/trimming/uppercasing of the batch, so this stays a thin
// pass-through rather than duplicating that parsing here.
// Unlike searchTickers, failures here are thrown (not swallowed) — this is
// a deliberate, explicit user action ("Fetch Intel"), so the caller should
// show the user what went wrong.
export async function fetchIntel(tickersInput: string): Promise<IntelBatchResponse> {
  const trimmedInput = tickersInput.trim();
  if (!trimmedInput) {
    throw new Error('Please enter at least one ticker symbol.');
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/intel/${encodeURIComponent(trimmedInput)}`);
  } catch {
    throw new Error(
      `Could not reach the Pipeline API at ${API_BASE_URL}. Check that the backend is running and that your device is on the same network.`,
    );
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errorBody = (await response.json()) as { detail?: string };
      detail = errorBody.detail ?? detail;
    } catch {
      // Response body was not valid JSON; fall back to the status text.
    }
    throw new Error(`Failed to fetch intel: ${detail}`);
  }

  const data = (await response.json()) as { results?: unknown };

  if (!Array.isArray(data.results)) {
    throw new Error('Received malformed intel data.');
  }

  const results: IntelTickerResult[] = data.results.map((entry: unknown) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const ticker = typeof record.ticker === 'string' ? record.ticker : 'UNKNOWN';
    const error = typeof record.error === 'string' ? record.error : undefined;
    const rawNews = Array.isArray(record.news) ? record.news : [];

    const news: IntelArticle[] = rawNews
      .filter((article): article is Record<string, unknown> => Boolean(article) && typeof article === 'object')
      .map((article) => ({
        title: typeof article.title === 'string' ? article.title : 'No Title',
        publisher: typeof article.publisher === 'string' ? article.publisher : 'Unknown Publisher',
        publishedAt: typeof article.published_at === 'string' ? article.published_at : 'N/A',
        link: typeof article.link === 'string' ? article.link : '',
        isCritical: article.is_critical === true,
        tag: typeof article.tag === 'string' ? article.tag : '',
      }));

    return { ticker, news, error };
  });

  return { results };
}

// Search-as-you-type autocomplete. Failures are swallowed and reported as
// "no results" rather than thrown: a flaky network or a slow provider
// shouldn't surface an error while the user is just typing, since manual
// ticker entry (followed by Add) still works independently of search.
export async function searchTickers(query: string): Promise<TickerSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/search/${encodeURIComponent(trimmedQuery)}`);
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  try {
    const data: unknown = await response.json();
    return Array.isArray(data) ? (data as TickerSearchResult[]) : [];
  } catch {
    return [];
  }
}
