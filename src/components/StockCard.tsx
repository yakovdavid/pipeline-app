import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { PipelineColors } from '@/constants/pipeline-colors';

export type Stock = {
  ticker: string;
  price: number;
  sma50: number;
};

export type StockCardProps = {
  stock: Stock;
  onDelete: (ticker: string) => void;
};

export function StockCard({ stock, onDelete }: StockCardProps) {
  const { ticker, price, sma50 } = stock;
  const isBullish = price > sma50;

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.ticker}>{ticker}</Text>
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
        <Text style={styles.sma}>SMA 50: ${sma50.toFixed(2)}</Text>
        <View
          style={[
            styles.badge,
            { backgroundColor: isBullish ? PipelineColors.bullish : PipelineColors.bearish },
          ]}>
          <Text style={styles.badgeText}>{isBullish ? 'Bullish' : 'Bearish'}</Text>
        </View>
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
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bottomRow: {
    marginTop: 10,
  },
  ticker: {
    color: PipelineColors.textPrimary,
    fontSize: 18,
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
  sma: {
    color: PipelineColors.textSecondary,
    fontSize: 14,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeText: {
    color: PipelineColors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
});
