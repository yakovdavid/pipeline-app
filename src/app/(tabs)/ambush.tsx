import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { StockCard, type Stock } from '@/components/StockCard';
import { TickerAutocomplete } from '@/components/TickerAutocomplete';
import { PipelineColors } from '@/constants/pipeline-colors';
import { AMBUSH_TICKERS_STORAGE_KEY } from '@/constants/storage-keys';
import { fetchStockData, type StockQuote } from '@/services/api';
import { formatAmbushLines } from '@/utils/report-formatters';

const DEFAULT_TICKERS = ['AAPL', 'TSLA'];

// "Ambush Radar" tracks stocks against their 50-day SMA to surface
// mean-reversion opportunities: a Bearish badge flags a stock trading below
// its trend, a Bullish badge flags one trading above it.
export default function AmbushRadarScreen() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [ticker, setTicker] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Load the saved watchlist on mount: read the ticker symbols from
  // AsyncStorage (falling back to a default watchlist on first launch),
  // then fetch fresh data for each from the Python API.
  useEffect(() => {
    let isMounted = true;

    async function loadInitialStocks() {
      let tickers: string[];
      try {
        const stored = await AsyncStorage.getItem(AMBUSH_TICKERS_STORAGE_KEY);
        tickers = stored ? (JSON.parse(stored) as string[]) : DEFAULT_TICKERS;
      } catch {
        tickers = DEFAULT_TICKERS;
      }

      const results = await Promise.allSettled(tickers.map((t) => fetchStockData(t)));

      const loadedStocks: Stock[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          loadedStocks.push({ ticker: tickers[index], ...result.value });
        }
      });

      if (isMounted) {
        setStocks(loadedStocks);
        setIsInitializing(false);
      }
    }

    loadInitialStocks();

    return () => {
      isMounted = false;
    };
  }, []);

  // Keep AsyncStorage in sync with the current watchlist. Skipped while
  // initializing so we don't overwrite storage before the saved list loads.
  useEffect(() => {
    if (isInitializing) {
      return;
    }

    const tickers = stocks.map((stock) => stock.ticker);
    AsyncStorage.setItem(AMBUSH_TICKERS_STORAGE_KEY, JSON.stringify(tickers)).catch((error) => {
      console.warn('Failed to save watchlist to storage:', error);
    });
  }, [stocks, isInitializing]);

  const handleAddTicker = async () => {
    const normalizedTicker = ticker.trim().toUpperCase();
    if (!normalizedTicker || isAdding) {
      return;
    }
    if (stocks.some((stock) => stock.ticker === normalizedTicker)) {
      setTicker('');
      return;
    }

    setIsAdding(true);
    try {
      const quote = await fetchStockData(normalizedTicker);
      setStocks((prevStocks) => [...prevStocks, { ticker: normalizedTicker, ...quote }]);
      setTicker('');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to fetch data for ${normalizedTicker}.`;
      Alert.alert('Could Not Add Ticker', message);
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteTicker = (tickerToDelete: string) => {
    setStocks((prevStocks) => prevStocks.filter((stock) => stock.ticker !== tickerToDelete));
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const tickersToRefresh = stocks.map((stock) => stock.ticker);
      const results = await Promise.allSettled(tickersToRefresh.map((t) => fetchStockData(t)));

      // Map successful results back by ticker (rather than by index) so a
      // concurrent add/delete during the fetch can't misalign the data.
      const freshQuotes = new Map<string, StockQuote>();
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          freshQuotes.set(tickersToRefresh[index], result.value);
        }
      });

      setStocks((prevStocks) =>
        prevStocks.map((stock) => {
          const freshQuote = freshQuotes.get(stock.ticker);
          return freshQuote ? { ticker: stock.ticker, ...freshQuote } : stock;
        }),
      );
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopyAmbushData = async () => {
    const timestamp = new Date().toLocaleString();
    const report = [`Ambush Radar Report — ${timestamp}`, '', ...formatAmbushLines(stocks)].join(
      '\n',
    );

    try {
      await Clipboard.setStringAsync(report);
      Alert.alert('Copied', 'Ambush Radar data copied to clipboard.');
    } catch {
      Alert.alert('Copy Failed', 'Could not copy Ambush Radar data to the clipboard.');
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Ambush Radar</Text>
      </View>

      <View style={styles.exportRow}>
        <TouchableOpacity style={styles.exportButton} onPress={handleCopyAmbushData}>
          <Text style={styles.exportButtonText}>Copy Ambush Data</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.inputRow}>
        <TickerAutocomplete
          value={ticker}
          onChangeText={setTicker}
          onSelectTicker={setTicker}
          onSubmit={handleAddTicker}
          editable={!isAdding}
        />
        <TouchableOpacity
          style={[styles.addButton, isAdding && styles.addButtonDisabled]}
          onPress={handleAddTicker}
          disabled={isAdding}>
          {isAdding ? (
            <ActivityIndicator size="small" color={PipelineColors.textPrimary} />
          ) : (
            <Text style={styles.addButtonText}>Add</Text>
          )}
        </TouchableOpacity>
      </View>

      {isInitializing ? (
        <View style={styles.initializingContainer}>
          <ActivityIndicator size="large" color={PipelineColors.textPrimary} />
          <Text style={styles.initializingText}>Loading your watchlist...</Text>
        </View>
      ) : (
        <FlatList
          data={stocks}
          keyExtractor={(item) => item.ticker}
          renderItem={({ item }) => <StockCard stock={item} onDelete={handleDeleteTicker} />}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={PipelineColors.textPrimary}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: PipelineColors.background,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: {
    color: PipelineColors.textPrimary,
    fontSize: 28,
    fontWeight: '700',
  },
  exportRow: {
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  exportButton: {
    backgroundColor: PipelineColors.cardBackground,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  exportButtonText: {
    color: PipelineColors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
    gap: 8,
    zIndex: 10,
  },
  addButton: {
    backgroundColor: PipelineColors.bullish,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonDisabled: {
    opacity: 0.6,
  },
  addButtonText: {
    color: PipelineColors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  listContent: {
    paddingBottom: 24,
  },
  initializingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  initializingText: {
    color: PipelineColors.textSecondary,
    fontSize: 14,
  },
});
