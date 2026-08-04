import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { PipelineColors } from '@/constants/pipeline-colors';
import { STRUCTURAL_STOP_THRESHOLD } from '@/constants/thresholds';
import type { AssetType } from '@/types/asset';

export type Stock = {
  ticker: string;
  assetType: AssetType;
  price: number;
  // Nullable: Yahoo Finance doesn't always publish these for every
  // instrument, so a missing value degrades the UI instead of failing it.
  sma50: number | null;
  sma200: number | null;
  // Anomaly News Fetcher output: set when today's move is 4%+ and the
  // backend found explanatory headlines. Not rendered on the card itself
  // (see report-formatters.ts) — just carried through so exports can use it.
  anomalyReport: string | null;
};

export type StockCardProps = {
  stock: Stock;
  onDelete: (ticker: string) => void;
};

export function StockCard({ stock, onDelete }: StockCardProps) {
  const { ticker, assetType, price, sma50, sma200 } = stock;

  // ETFs are judged against the longer 200-day trend; individual stocks
  // keep the original 50-day mean-reversion rule.
  const relevantSma = assetType === 'ETF' ? sma200 : sma50;
  const hasTrendData = relevantSma !== null;
  const isBullish = hasTrendData && price > relevantSma;

  const isNearStructuralStop =
    assetType === 'ETF' && sma200 !== null && price <= sma200 * STRUCTURAL_STOP_THRESHOLD;

  return (
    <View style={styles.card}>
      {isNearStructuralStop && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningBannerText}>
            ⚠ Structural Stop Warning: within 2% of SMA200 support
          </Text>
        </View>
      )}

      <View style={styles.row}>
        <View style={styles.tickerGroup}>
          <Text style={styles.ticker}>{ticker}</Text>
          <View style={styles.assetTypeBadge}>
            <Text style={styles.assetTypeBadgeText}>{assetType}</Text>
          </View>
        </View>
        <View style={styles.priceGroup}>
          <Text style={styles.price}>${price.toFixed(2)}</Text>
          <TouchableOpacity
            onPress={() => onDelete(ticker)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={`Remove ${ticker} from watchlist`}>
            <Text style={styles.deleteButtonText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={[styles.row, styles.bottomRow]}>
        <MomentumBar price={price} sma50={sma50} sma200={sma200} isBullish={isBullish} />
        <View
          style={[
            styles.badge,
            {
              backgroundColor: !hasTrendData
                ? PipelineColors.textSecondary
                : isBullish
                  ? PipelineColors.bullish
                  : PipelineColors.bearish,
            },
          ]}>
          <Text style={styles.badgeText}>
            {!hasTrendData ? 'N/A' : isBullish ? 'Bullish' : 'Bearish'}
          </Text>
        </View>
      </View>
    </View>
  );
}

type MomentumBarProps = {
  price: number;
  sma50: number | null;
  sma200: number | null;
  isBullish: boolean;
};

// Minimalist visual showing where the current price sits relative to the
// SMA50/SMA200 range, replacing the old plain "SMA 50: $X" text line.
function MomentumBar({ price, sma50, sma200, isBullish }: MomentumBarProps) {
  if (sma50 === null || sma200 === null) {
    return <Text style={styles.momentumFallbackText}>Insufficient SMA data</Text>;
  }

  const low = Math.min(sma50, sma200);
  const high = Math.max(sma50, sma200);
  const range = high - low;
  const rawPosition = range > 0 ? (price - low) / range : 0.5;
  const markerPosition = Math.min(1, Math.max(0, rawPosition));
  const markerColor = isBullish ? PipelineColors.bullish : PipelineColors.bearish;

  const lowLabel = low === sma50 ? 'SMA50' : 'SMA200';
  const highLabel = high === sma50 ? 'SMA50' : 'SMA200';

  return (
    <View style={styles.momentumContainer}>
      <View style={styles.momentumTrack}>
        <View
          style={[
            styles.momentumMarker,
            { left: `${markerPosition * 100}%`, backgroundColor: markerColor },
          ]}
        />
      </View>
      <View style={styles.momentumLabelRow}>
        <Text style={styles.momentumLabelText}>
          {lowLabel} ${low.toFixed(2)}
        </Text>
        <Text style={styles.momentumLabelText}>
          {highLabel} ${high.toFixed(2)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: PipelineColors.cardBackground,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginHorizontal: 16,
    marginBottom: 12,
    overflow: 'hidden',
  },
  warningBanner: {
    backgroundColor: PipelineColors.warning,
    marginHorizontal: -16,
    marginTop: -14,
    marginBottom: 10,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  warningBannerText: {
    color: PipelineColors.background,
    fontSize: 12,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bottomRow: {
    marginTop: 12,
    alignItems: 'flex-start',
  },
  tickerGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  ticker: {
    color: PipelineColors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  assetTypeBadge: {
    backgroundColor: PipelineColors.background,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  assetTypeBadgeText: {
    color: PipelineColors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
  },
  priceGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  price: {
    color: PipelineColors.textPrimary,
    fontSize: 18,
    fontWeight: '600',
  },
  deleteButtonText: {
    color: PipelineColors.bearish,
    fontSize: 16,
    fontWeight: '700',
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginLeft: 12,
  },
  badgeText: {
    color: PipelineColors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  momentumContainer: {
    flex: 1,
  },
  momentumFallbackText: {
    flex: 1,
    color: PipelineColors.textSecondary,
    fontSize: 13,
  },
  momentumTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: PipelineColors.background,
    justifyContent: 'center',
  },
  momentumMarker: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: -6,
  },
  momentumLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  momentumLabelText: {
    color: PipelineColors.textSecondary,
    fontSize: 11,
  },
});
