import type { Stock } from '@/components/StockCard';
import { STRUCTURAL_STOP_THRESHOLD } from '@/constants/thresholds';
import type { PortfolioStock } from '@/types/portfolio';

// Shared by the Ambush Radar screen's own export and the Portfolio screen's
// combined export, so the two reports describe Ambush data identically.
export function formatAmbushLines(stocks: Stock[]): string[] {
  if (stocks.length === 0) {
    return ['  (none)'];
  }
  return stocks.flatMap((stock) => {
    // ETFs are judged against SMA200, stocks against SMA50 — matches the
    // trend rule rendered on the card itself (see StockCard.tsx).
    const relevantSma = stock.assetType === 'ETF' ? stock.sma200 : stock.sma50;
    const trend = relevantSma === null ? 'N/A' : stock.price > relevantSma ? 'Bullish' : 'Bearish';
    const sma50Text = stock.sma50 === null ? 'N/A' : `$${stock.sma50.toFixed(2)}`;
    const sma200Text = stock.sma200 === null ? 'N/A' : `$${stock.sma200.toFixed(2)}`;

    const isNearStructuralStop =
      stock.assetType === 'ETF' &&
      stock.sma200 !== null &&
      stock.price <= stock.sma200 * STRUCTURAL_STOP_THRESHOLD;
    const warningSuffix = isNearStructuralStop ? ' [STRUCTURAL STOP WARNING]' : '';

    const line =
      `  ${stock.ticker} (${stock.assetType}): Price $${stock.price.toFixed(2)} | ` +
      `SMA50 ${sma50Text} | SMA200 ${sma200Text} | ${trend}${warningSuffix}`;

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
        const totalValue = stock.units * stock.price;
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
