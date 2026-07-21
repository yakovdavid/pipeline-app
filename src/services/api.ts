export type StockQuote = {
  price: number;
  sma50: number;
};

// LAN IP of the machine running the FastAPI backend (see /backend).
// Update this if your development machine's local network address changes.
const API_BASE_URL = 'http://192.168.1.181:8000';

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

  if (typeof data.price !== 'number' || typeof data.sma50 !== 'number') {
    throw new Error(`Received malformed data for ${normalizedTicker}.`);
  }

  return { price: data.price, sma50: data.sma50 };
}
