import type { Stock } from '@/components/StockCard';
import type { PortfolioStock } from '@/types/portfolio';

// Shared by the Ambush Radar screen's own export and the Portfolio screen's
// combined export, so the two reports describe Ambush data identically.
export function formatAmbushLines(stocks: Stock[]): string[] {
  if (stocks.length === 0) {
    return ['  (none)'];
  }
  return stocks.map((stock) => {
    const trend = stock.price > stock.sma50 ? 'Bullish' : 'Bearish';
    return `  ${stock.ticker}: Price $${stock.price.toFixed(2)} | SMA50 $${stock.sma50.toFixed(2)} | ${trend}`;
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
      sectionStocks.forEach((stock) => lines.push(`  ${stock.ticker}: $${stock.price.toFixed(2)}`));
    }

    if (index < PORTFOLIO_SECTIONS.length - 1) {
      lines.push('');
    }
  });

  return lines;
}
