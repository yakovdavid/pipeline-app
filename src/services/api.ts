export type StockQuote = {
  price: number;
  // Yahoo Finance doesn't always publish these for every instrument (e.g. a
  // very newly listed ticker), so the backend passes that absence through
  // as null rather than failing the whole request.
  sma50: number | null;
  sma200: number | null;
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

  const data = (await response.json()) as Partial<StockQuote> & {
    anomaly?: string | null;
    high_52?: number | null;
    drawdown_pct?: number | null;
  };

  if (typeof data.price !== 'number') {
    throw new Error(`Received malformed data for ${normalizedTicker}.`);
  }

  return {
    price: data.price,
    sma50: typeof data.sma50 === 'number' ? data.sma50 : null,
    sma200: typeof data.sma200 === 'number' ? data.sma200 : null,
    anomalyReport: typeof data.anomaly === 'string' ? data.anomaly : null,
    high52: typeof data.high_52 === 'number' ? data.high_52 : null,
    drawdownPct: typeof data.drawdown_pct === 'number' ? data.drawdown_pct : null,
  };
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
