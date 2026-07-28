export type StockQuote = {
  price: number;
  // Yahoo Finance doesn't always publish these for every instrument (e.g. a
  // very newly listed ticker), so the backend passes that absence through
  // as null rather than failing the whole request.
  sma50: number | null;
  sma200: number | null;
};

export type TickerSearchResult = {
  symbol: string;
  shortname: string;
  exchDisp: string;
};

// Production FastAPI backend (see /backend), deployed on Render.
const API_BASE_URL = 'https://pipeline-app-1a68.onrender.com';

export async function fetchStockData(ticker: string): Promise<StockQuote> {
  const normalizedTicker = ticker.trim().toUpperCase();

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/stock/${normalizedTicker}`);
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

  const data = (await response.json()) as Partial<StockQuote>;

  if (typeof data.price !== 'number') {
    throw new Error(`Received malformed data for ${normalizedTicker}.`);
  }

  return {
    price: data.price,
    sma50: typeof data.sma50 === 'number' ? data.sma50 : null,
    sma200: typeof data.sma200 === 'number' ? data.sma200 : null,
  };
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
