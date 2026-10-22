import type { AmbushAsset } from '@/types/ambush';
import { STRUCTURAL_STOP_THRESHOLD } from '@/constants/thresholds';
import type { PortfolioStock } from '@/types/portfolio';
import type { AllocationBreakdown } from '@/utils/allocation';
import { positionUsdValue, usdUnitPrice } from '@/utils/fx';
import { formatUsd } from '@/utils/trade-execution';

// Shared by the Ambush Radar screen's own export and the Portfolio screen's
// combined export, so the two reports describe Ambush data identically.
// Each line is tagged with its layer; Quality lines report the backend's
// fundamentals and Z-Score, Satellite lines the technicals.
export function formatAmbushLines(stocks: AmbushAsset[]): string[] {
  if (stocks.length === 0) {
    return ['  (none)'];
  }
  return stocks.flatMap((stock) => {
    // DATA-LOSS FIX: a ticker whose fetch failed is still listed, but its
    // placeholder numbers are never printed as real prices.
    if (stock.priceStatus === 'unavailable') {
      return [`  ${stock.ticker} (${stock.assetType}, ${stock.layer}): PRICE UNAVAILABLE (fetch failed)`];
    }
    if (stock.layer === 'Quality') {
      const roicText = stock.roic === null ? 'N/A' : `${stock.roic.toFixed(1)}%`;
      const zScoreText = stock.zScore === null ? 'N/A' : stock.zScore.toFixed(2);
      return [
        `  ${stock.ticker} (${stock.assetType}, Quality): Price $${stock.price.toFixed(2)} | ` +
          `ROIC ${roicText} | Moat: ${stock.moat ?? 'N/A'} | Z-Score: ${zScoreText}`,
      ];
    }
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
      `  ${stock.ticker} (${stock.assetType}, Satellite): Price $${stock.price.toFixed(2)} | ` +
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

// GAP 3: `usdIlsRate` is the live USD/ILS rate; Israeli positions are
// valued with it (see positionUsdValue), exactly as on screen.
export function formatPortfolioLines(stocks: PortfolioStock[], usdIlsRate: number | null): string[] {
  const lines: string[] = [];

  PORTFOLIO_SECTIONS.forEach(({ category, title }, index) => {
    const sectionStocks = stocks.filter((stock) => stock.category === category);

    lines.push(title);
    if (sectionStocks.length === 0) {
      lines.push('  (none)');
    } else {
      sectionStocks.forEach((stock) => {
        // DATA-LOSS FIX: listed with its real unit count, but no price or
        // value, since those are placeholders while the fetch has failed.
        if (stock.priceStatus === 'unavailable') {
          lines.push(`  ${stock.ticker}: ${stock.units} units @ PRICE UNAVAILABLE (fetch failed)`);
          return;
        }
        // TASE ETF MATH FIX (Nominal Value / Erech Nakuv): see
        // getEffectiveUnits — a TASE ETF's raw `units` is a Nominal Value
        // quantity (100 nominal units = 1 real pricing unit), so it's
        // converted before being multiplied by price, same as the on-screen
        // total in PortfolioStockRow (index.tsx). The report still displays
        // the RAW units held (what the user actually entered), only the
        // computed total value uses the effective (real) unit count.
        // GAP 3: the USD unit price and total come from the same explicit
        // FX conversion the screen uses. Four decimals on the unit price,
        // so a sub-dollar fund unit isn't shown rounded to $1.00.
        const unitPriceUsd = usdUnitPrice(stock, usdIlsRate);
        const totalValue = positionUsdValue(stock, usdIlsRate);
        const unitPriceText = unitPriceUsd < 10 ? unitPriceUsd.toFixed(4) : unitPriceUsd.toFixed(2);
        // TRADE RECONCILIATION: the recorded execution cost, when known.
        const costSuffix = stock.costBasisUsd === null ? '' : ` | cost basis ${formatUsd(stock.costBasisUsd)}`;
        lines.push(
          `  ${stock.ticker}: ${stock.units} units @ $${unitPriceText} = $${totalValue.toFixed(2)}${costSuffix}`,
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

// SNAPSHOT HEADER: the real-time summary at the top of both Portfolio
// exports ("Copy Portfolio Data" and "Copy ALL Data"), in the same terms
// the Portfolio's summary card shows:
//   1. Total Portfolio Value: invested + cash (the allocation denominator);
//   2. Available Buying Power (cash balance);
//   3. the USD/ILS rate every Israeli position in the snapshot was valued
//      with (see @/utils/fx);
//   4. each layer's actual, cash-diluted weight next to its target (Cash
//      has no target). Weights sum to exactly 100.0%, see computeAllocation.
// A cash balance that hasn't loaded, or a rate that hasn't been fetched, is
// labelled as such rather than printed as a misleading number.
export type SnapshotHeaderInput = {
  allocation: AllocationBreakdown;
  // Null until the saved balance has been read.
  cashBalance: number | null;
  usdIlsRate: number | null;
  targetPct: Record<'Core' | 'Satellite' | 'Quality', number>;
};

export function formatSnapshotHeader({ allocation, cashBalance, usdIlsRate, targetPct }: SnapshotHeaderInput): string[] {
  const { weightsPct } = allocation;
  const layerLine = (label: string, actual: number, target: number | null): string =>
    `  ${label.padEnd(10)} ${`${actual.toFixed(1)}%`.padStart(6)}  /  ${target === null ? '—' : `${target}%`}`;
  return [
    `Total Portfolio Value (Invested + Cash): ${formatUsd(allocation.totalValue)}`,
    `Available Buying Power (Cash): ${cashBalance === null ? 'not loaded' : formatUsd(cashBalance)}`,
    `USD/ILS rate: ${
      usdIlsRate === null ? 'unavailable (Israeli positions valued at the API USD price)' : usdIlsRate.toFixed(4)
    }`,
    'Layer Allocation (Actual / Target):',
    layerLine('Core', weightsPct.Core, targetPct.Core),
    layerLine('Satellite', weightsPct.Satellite, targetPct.Satellite),
    layerLine('Quality', weightsPct.Quality, targetPct.Quality),
    layerLine('Cash', weightsPct.Cash, null),
  ];
}
