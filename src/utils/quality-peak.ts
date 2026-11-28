// QUALITY AUDIT REFERENCE PEAK (approved 2026-11-28, backlog P12). Pure (no
// app imports), so it runs under `node --test`.
//
// Why: Quality entries require Z <= -1, so they are almost always bought
// more than 15% below the 52-week high. Measured from the 52-week high,
// FUNDAMENTAL AUDIT fired at purchase, and after "thesis intact" it only
// re-armed above the old -15% line, so a new real drawdown was never caught.
//
// Rule: the AUDIT reference is the position's own peak since entry:
//   qualityPeakSinceEntry = max(highest daily close since the first BUY,
//                               first entry price)
// persisted per holding in normalized local currency (Shekels for ".TA",
// the backend's raw Agorot ÷100 exactly once), raised by every new daily
// close and never lowered. Add-on buys don't reset it.
//   drawdown = close / qualityPeakSinceEntry - 1, trigger at <= -15%
// (daily close; the latch and re-arm rules of @/utils/audit-latch are
// unchanged).
//
// Holdings bought before this rule are initialized once: an approved seed
// if there is one, else the highest close since their first BUY in the
// execution ledger (and its entry price), else the current 52-week high.

export const QUALITY_AUDIT_TRIGGER_PCT = -15;

// Approved seeds, 2026-11-28 (listing currency). FICO's entry: 2026-11-27.
export const QUALITY_PEAK_SEEDS: Readonly<Record<string, number>> = {
  FICO: 706.5,
  ADBE: 235.44,
  INTU: 276.5,
};

const TASE_SUFFIX = '.TA';
const AGOROT_PER_SHEKEL = 100;

function isTase(ticker: string): boolean {
  return ticker.trim().toUpperCase().endsWith(TASE_SUFFIX);
}

// A raw close from GET /api/quality (listing currency: Agorot for ".TA")
// in normalized local currency.
export function closeToLocal(ticker: string, rawClose: number | null): number | null {
  if (rawClose === null || !Number.isFinite(rawClose) || rawClose <= 0) {
    return null;
  }
  return isTase(ticker) ? rawClose / AGOROT_PER_SHEKEL : rawClose;
}

// A broker-typed price (Agorot for ".TA") in normalized local currency.
export function brokerPriceToLocal(ticker: string, price: number): number | null {
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }
  return isTase(ticker) ? price / AGOROT_PER_SHEKEL : price;
}

export function seedPeakFor(ticker: string): number | null {
  return QUALITY_PEAK_SEEDS[ticker.trim().toUpperCase()] ?? null;
}

function maxOf(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
  return known.length > 0 ? Math.max(...known) : null;
}

// One-way: a new close only ever raises the peak. A peak that isn't
// initialized yet stays null (initialization has its own inputs).
export function advancePeak(peak: number | null, closeLocal: number | null): number | null {
  if (peak === null) {
    return null;
  }
  return closeLocal !== null && closeLocal > peak ? closeLocal : peak;
}

export type PeakInitInputs = {
  seed: number | null;
  // From the first BUY in the execution ledger, when there is one.
  hasFirstBuy: boolean;
  maxCloseSinceFirstBuy: number | null;
  firstEntryPrice: number | null;
  // Fallback when there's no BUY record.
  high52wClose: number | null;
  // The latest completed close, so the peak is never below it.
  latestClose: number | null;
};

export function initialPeak(inputs: PeakInitInputs): number | null {
  if (inputs.seed !== null) {
    return maxOf([inputs.seed, inputs.latestClose]);
  }
  if (inputs.hasFirstBuy) {
    return maxOf([inputs.maxCloseSinceFirstBuy, inputs.firstEntryPrice, inputs.latestClose]);
  }
  return maxOf([inputs.high52wClose, inputs.latestClose]);
}

export function drawdownFromPeakPct(closeLocal: number | null, peak: number | null): number | null {
  if (closeLocal === null || peak === null || peak <= 0) {
    return null;
  }
  return (closeLocal / peak - 1) * 100;
}

// The close at which AUDIT fires: peak × 0.85.
export function auditTriggerLevel(peak: number): number {
  return peak * (1 + QUALITY_AUDIT_TRIGGER_PCT / 100);
}

export type BuyRecordLike = { ticker: string; side: 'buy' | 'sell'; executedAt: string; price: number };

// The earliest BUY for this ticker in the ledger, or null.
export function firstBuyRecord<T extends BuyRecordLike>(records: readonly T[], ticker: string): T | null {
  const symbol = ticker.trim().toUpperCase();
  let first: T | null = null;
  for (const record of records) {
    if (record.side === 'buy' && record.ticker.trim().toUpperCase() === symbol) {
      if (first === null || record.executedAt < first.executedAt) {
        first = record;
      }
    }
  }
  return first;
}
