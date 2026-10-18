import type { AssetType } from '@/types/asset';
import { getEffectiveUnits, isTaseTicker } from '@/utils/currency';

// TRADE RECONCILIATION: the math behind the "Execute Trade" modal, kept
// free of React so it can be tested on its own.
//
// Cash is held in USD (see CASH_BALANCE_STORAGE_KEY), but a trade is
// entered the way the broker statement shows it: in the instrument's own
// currency. Total Cost = (Executed Quantity × Executed Price) + Broker Fee,
// computed in that currency and then converted to USD. For a US-listed
// ticker the conversion rate is exactly 1, so this is literally the PRD
// formula. Two TASE conventions (see @/utils/currency) are applied so the
// cost matches how the app values the same position:
//   - a ".TA" price is entered in Agorot, as Israeli brokers quote it and
//     as the app displays it (formatUnitPrice), and converted to Shekels;
//   - a TASE ETF quantity is in Nominal Value units, converted with
//     getEffectiveUnits (100 nominal units = 1 pricing unit).

const AGOROT_PER_SHEKEL = 100;

// What a trade needs from the live quote to be priced in USD.
export type TradePricingBasis = {
  ticker: string;
  assetType: AssetType;
  // USD per one unit of the instrument's local currency (1 for USD).
  usdPerLocal: number;
  // The local currency's symbol ('$' or '₪'), for labels.
  currencySymbol: string;
};

export type TradeInputs = {
  quantity: number;
  price: number;
  fee: number;
};

export type TradeCost = {
  // In the instrument's local currency (Shekels for TASE, never Agorot).
  totalLocal: number;
  // What is deducted from the USD cash balance, rounded to cents.
  totalUsd: number;
};

export function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

// The live quote carries the same price twice: `price` in USD and
// `localPrice` in the local currency. Their ratio is the conversion rate.
// Null when either is missing, zero or not finite (e.g. a failed fetch),
// since a trade can't be priced without it.
export function usdPerLocalFromQuote(usdPrice: number, localPrice: number): number | null {
  if (!Number.isFinite(usdPrice) || !Number.isFinite(localPrice) || usdPrice <= 0 || localPrice <= 0) {
    return null;
  }
  return usdPrice / localPrice;
}

// Whether the Executed Price field is in Agorot (true for ".TA" tickers).
export function isPriceEnteredInAgorot(ticker: string): boolean {
  return isTaseTicker(ticker);
}

function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// All three fields are required: quantity and price must be positive, the
// fee zero or more. Commas are accepted as thousands separators.
export function parseTradeInputs(quantityText: string, priceText: string, feeText: string): TradeInputs | null {
  const quantity = parseNumber(quantityText);
  const price = parseNumber(priceText);
  const fee = parseNumber(feeText);
  if (quantity === null || price === null || fee === null) {
    return null;
  }
  if (quantity <= 0 || price <= 0 || fee < 0) {
    return null;
  }
  return { quantity, price, fee };
}

// Executed Quantity × Executed Price, in the local currency, with both TASE
// conventions applied (see the header comment).
function grossLocal(inputs: TradeInputs, basis: TradePricingBasis): number {
  const unitPriceLocal = isPriceEnteredInAgorot(basis.ticker) ? inputs.price / AGOROT_PER_SHEKEL : inputs.price;
  return getEffectiveUnits(basis.ticker, basis.assetType, inputs.quantity) * unitPriceLocal;
}

// BUY: Total Cost = (Executed Quantity × Executed Price) + Broker Fee.
export function computeTradeCost(inputs: TradeInputs, basis: TradePricingBasis): TradeCost {
  const totalLocal = grossLocal(inputs, basis) + inputs.fee;
  return { totalLocal, totalUsd: roundToCents(totalLocal * basis.usdPerLocal) };
}

// SELL: Net Proceeds = (Executed Quantity × Executed Price) - Broker Fee,
// with the same currency handling as a buy. Negative only when the fee is
// larger than the sale itself.
export function computeSaleProceeds(inputs: TradeInputs, basis: TradePricingBasis): TradeCost {
  const totalLocal = grossLocal(inputs, basis) - inputs.fee;
  return { totalLocal, totalUsd: roundToCents(totalLocal * basis.usdPerLocal) };
}

// Unit counts can be fractional (fund units, fractional shares), so they
// are compared with a tolerance and rounded after subtraction: 10.3 - 0.1
// is 10.200000000000001 in floating point.
const UNIT_DECIMALS = 1e8;

function unitTolerance(unitsHeld: number): number {
  return 1e-9 * Math.max(1, Math.abs(unitsHeld));
}

export function roundUnits(units: number): number {
  return Math.round(units * UNIT_DECIMALS) / UNIT_DECIMALS;
}

// Selling exactly the units held closes the position.
export function isFullSale(quantity: number, unitsHeld: number): boolean {
  return Math.abs(quantity - unitsHeld) <= unitTolerance(unitsHeld);
}

export function exceedsHolding(quantity: number, unitsHeld: number): boolean {
  return quantity - unitsHeld > unitTolerance(unitsHeld);
}

export function remainingUnitsAfterSale(unitsHeld: number, quantity: number): number {
  return isFullSale(quantity, unitsHeld) ? 0 : roundUnits(unitsHeld - quantity);
}

// Average-cost method: a partial sale removes the sold share of the cost
// basis, so the remaining units keep their original average cost.
export function reduceCostBasis(costBasisUsd: number, unitsHeld: number, remainingUnits: number): number {
  if (unitsHeld <= 0) {
    return 0;
  }
  return roundToCents((costBasisUsd * remainingUnits) / unitsHeld);
}

// "$1,234.56" / "-₪1,234.56". Built by hand rather than with Intl, so the
// output is identical on every JS engine.
export function formatMoney(value: number, currencySymbol: string): string {
  const sign = value < 0 ? '-' : '';
  const [whole, cents] = Math.abs(roundToCents(value)).toFixed(2).split('.');
  return `${sign}${currencySymbol}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

export function formatUsd(value: number): string {
  return formatMoney(value, '$');
}

// "+$1,250.00" / "-$12.50", for cash movements.
export function formatSignedUsd(value: number): string {
  return value >= 0 ? `+${formatUsd(value)}` : formatUsd(value);
}

// CASH CORRECTION ("Adjust Cash"). The amount is always entered as a
// positive number; the sign comes from the Deposit/Withdraw toggle, never
// from the text, so a stray minus can't flip the direction the user
// picked. Accepts "1250" and "1,250.50"; rejects empty, zero, negative
// and non-numbers.
export type CashAdjustmentDirection = 'deposit' | 'withdraw';

export function parseCashAmount(text: string): number | null {
  const value = parseNumber(text);
  if (value === null) {
    return null;
  }
  const rounded = roundToCents(value);
  return rounded > 0 ? rounded : null;
}

export function signedCashDelta(amount: number, direction: CashAdjustmentDirection): number {
  return direction === 'withdraw' ? -amount : amount;
}
