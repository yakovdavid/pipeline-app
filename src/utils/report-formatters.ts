import type { Stock } from '@/components/StockCard';
import { STRUCTURAL_STOP_THRESHOLD } from '@/constants/thresholds';
import type { PortfolioStock } from '@/types/portfolio';
import { getEffectiveUnits } from '@/utils/currency';

// Shared by the Ambush Radar screen's own export and the Portfolio screen's
// combined export, so the two reports describe Ambush data identically.
export function formatAmbushLines(stocks: Stock[]): string[] {
  if (stocks.length === 0) {
    return ['  (none)'];
  }
  return stocks.flatMap((stock) => {
    // TREND CLASSIFICATION: both backend-computed signals (see
    // backend/main.py's _classify_trend), replacing the old single,
    // asset-type-dependent Bullish/Bearish verdict this export used to
    // compute itself (SMA200 for ETFs, SMA50 for Stocks) — matches the
    // Macro Trend / Tactical Momentum badges rendered on the card itself
    // (see StockCard.tsx / TrendBadges).
    const macroTrendText = stock.macroTrend ?? 'N/A';
    const tacticalMomentumText = stock.tacticalMomentum ?? 'N/A';
    const sma50Text = stock.sma50 === null ? 'N/A' : `$${stock.sma50.toFixed(2)}`;
    const sma200Text = stock.sma200 === null ? 'N/A' : `$${stock.sma200.toFixed(2)}`;

    const isNearStructuralStop =
      stock.assetType === 'ETF' &&
      stock.sma200 !== null &&
      stock.price <= stock.sma200 * STRUCTURAL_STOP_THRESHOLD;
    const warningSuffix = isNearStructuralStop ? ' [STRUCTURAL STOP WARNING]' : '';

    const line =
      `  ${stock.ticker} (${stock.assetType}): Price $${stock.price.toFixed(2)} | ` +
      `SMA50 ${sma50Text} | SMA200 ${sma200Text} | Macro: ${macroTrendText} | ` +
      `Tactical: ${tacticalMomentumText}${warningSuffix}`;

    return stock.anomalyReport ? [line, `    ${stock.anomalyReport}`] : [line];
  });
}

const PORTFOLIO_SECTIONS: { category: PortfolioStock['category']; title: string }[] = [
  { category: 'Core', title: 'CORE (70%)' },
  { category: 'Satellite', title: 'SATELLITE (20%)' },
  { category: 'Quality', title: 'QUALITY (10%)' },
];

export function formatPortfolioLines(stocks: PortfolioStock[]): string[] {
  const lines: string[] = [];

  PORTFOLIO_SECTIONS.forEach(({ category, title }, index) => {
    const sectionStocks = stocks.filter((stock) => stock.category === category);

    lines.push(title);
    if (sectionStocks.length === 0) {
      lines.push('  (none)');
    } else {
      sectionStocks.forEach((stock) => {
        // TASE ETF MATH FIX (Nominal Value / Erech Nakuv): see
        // getEffectiveUnits — a TASE ETF's raw `units` is a Nominal Value
        // quantity (100 nominal units = 1 real pricing unit), so it's
        // converted before being multiplied by price, same as the on-screen
        // total in PortfolioStockRow (index.tsx). The report still displays
        // the RAW units held (what the user actually entered), only the
        // computed total value uses the effective (real) unit count.
        const effectiveUnits = getEffectiveUnits(stock.ticker, stock.assetType, stock.units);
        const totalValue = effectiveUnits * stock.price;
        lines.push(
          `  ${stock.ticker}: ${stock.units} units @ $${stock.price.toFixed(2)} = $${totalValue.toFixed(2)}`,
        );
        if (stock.anomalyReport) {
          lines.push(`    ${stock.anomalyReport}`);
        }
      });
    }

    if (index < PORTFOLIO_SECTIONS.length - 1) {
      lines.push('');
    }
  });

  return lines;
}
