import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { STRUCTURAL_STOP_THRESHOLD } from '@/constants/thresholds';
import { fetchStockData, type StockQuote } from '@/services/api';
import type { AmbushTickerEntry } from '@/types/ambush';
import type { AssetType } from '@/types/asset';
import { loadAmbushTickerEntries } from '@/utils/ambush-storage';
import { sendStructuralStopNotification } from '@/utils/notifications';
import { formatAmbushLines } from '@/utils/report-formatters';
import { normalizeTickerInput } from '@/utils/ticker';

const DEFAULT_ENTRIES: AmbushTickerEntry[] = [
  { ticker: 'AAPL', assetType: 'Stock' },
  { ticker: 'TSLA', assetType: 'Stock' },
];

// "Ambush Radar" tracks stocks and ETFs against their trend to surface
// mean-reversion opportunities: stocks are judged against SMA50, ETFs
// against the longer SMA200 (see StockCard for the trend rule itself).
export default function AmbushRadarScreen() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [ticker, setTicker] = useState('');
  const [selectedAssetType, setSelectedAssetType] = useState<AssetType>('Stock');
  const [isAdding, setIsAdding] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Tracks which ETFs have already triggered a structural stop notification
  // this session, so we notify once per crossing rather than on every
  // render while the price stays inside the warning zone.
  const notifiedTickersRef = useRef<Set<string>>(new Set());

  // Load the saved watchlist every time this tab gains focus (including the
  // initial mount) — not just once on mount — so a backup restored from the
  // Portfolio tab's Import menu (a separate mounted screen this one has no
  // direct handle to) is picked up as soon as the user switches back here,
  // rather than only on the next full app restart.
  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      async function loadStocks() {
        // Hydration hardening: a storage read/parse failure is NOT the
        // same thing as "the user has no saved tickers" — those must be
        // told apart. Falling back to DEFAULT_ENTRIES here (as this code
        // used to) would silently overwrite a real watchlist with
        // AAPL/TSLA on a mere transient AsyncStorage hiccup, and this
        // effect re-runs on every tab focus (not just app startup), so
        // that could happen repeatedly during normal use.
        let entries: AmbushTickerEntry[];
        try {
          entries = (await loadAmbushTickerEntries()) ?? DEFAULT_ENTRIES;
        } catch (error) {
          console.error(
            '[hydration] Failed to read the Ambush watchlist from storage; retaining the ' +
              'previous state instead of falling back to defaults.',
            error,
          );
          if (isActive) {
            setIsInitializing(false);
          }
          return;
        }

        if (entries.length === 0) {
          // A genuinely empty, successfully-read list (the user deleted
          // every ticker) is valid state, not a failure — show it as-is.
          if (isActive) {
            setStocks([]);
            setIsInitializing(false);
          }
          return;
        }

        const results = await Promise.allSettled(entries.map((entry) => fetchStockData(entry.ticker)));

        const loadedStocks: Stock[] = [];
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            loadedStocks.push({ ...entries[index], ...result.value });
          }
        });

        if (loadedStocks.length === 0) {
          // Every single live-quote fetch failed — almost certainly a
          // network outage, not "these tickers don't exist". The storage
          // read above succeeded and returned real tickers, so silently
          // replacing them with an empty list here would be exactly the
          // data-loss bug being fixed: the persistence effect below would
          // then immediately overwrite the real saved watchlist with [].
          console.error(
            `[hydration] All ${entries.length} ticker fetch(es) failed (network issue?); ` +
              'retaining the previous watchlist instead of clearing it.',
          );
          if (isActive) {
            setIsInitializing(false);
          }
          return;
        }

        if (isActive) {
          setStocks(loadedStocks);
          setIsInitializing(false);
        }
      }

      loadStocks();

      return () => {
        isActive = false;
      };
    }, []),
  );

  // Keep AsyncStorage in sync with the current watchlist. Skipped while
  // initializing so we don't overwrite storage before the saved list loads.
  useEffect(() => {
    if (isInitializing) {
      return;
    }

    const entries: AmbushTickerEntry[] = stocks.map(({ ticker: symbol, assetType }) => ({
      ticker: symbol,
      assetType,
    }));
    AsyncStorage.setItem(AMBUSH_TICKERS_STORAGE_KEY, JSON.stringify(entries)).catch((error) => {
      console.warn('Failed to save watchlist to storage:', error);
    });
  }, [stocks, isInitializing]);

  // Fire a one-time local notification for any ETF that has just entered
  // the structural stop warning zone (within 2% of its SMA200). Re-arms if
  // the price later moves back out, so a later re-entry notifies again.
  useEffect(() => {
    stocks.forEach((stock) => {
      const isNearStructuralStop =
        stock.assetType === 'ETF' &&
        stock.sma200 !== null &&
        stock.price <= stock.sma200 * STRUCTURAL_STOP_THRESHOLD;

      if (isNearStructuralStop) {
        if (!notifiedTickersRef.current.has(stock.ticker)) {
          notifiedTickersRef.current.add(stock.ticker);
          sendStructuralStopNotification(stock.ticker, stock.price, stock.sma200 as number);
        }
      } else {
        notifiedTickersRef.current.delete(stock.ticker);
      }
    });
  }, [stocks]);

  const handleAddTicker = async () => {
    const normalizedTicker = normalizeTickerInput(ticker);
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
      setStocks((prevStocks) => [
        ...prevStocks,
        { ticker: normalizedTicker, assetType: selectedAssetType, ...quote },
      ]);
      setTicker('');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to fetch data for ${normalizedTicker}.`;
      Alert.alert('Could Not Add Ticker', message);
    } finally {
      setIsAdding(false);
    }
  };

  // Stable identity (useCallback) is required for the React.memo on
  // StockCard to actually skip re-renders — an inline function here would
  // be a new reference on every AmbushRadarScreen render, which would
  // defeat memo() by changing this prop for every row on every render.
  const handleDeleteTicker = useCallback((tickerToDelete: string) => {
    setStocks((prevStocks) => prevStocks.filter((stock) => stock.ticker !== tickerToDelete));
  }, []);

  const renderStockCard = useCallback(
    ({ item }: { item: Stock }) => <StockCard stock={item} onDelete={handleDeleteTicker} />,
    [handleDeleteTicker],
  );

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
          return freshQuote ? { ...stock, ...freshQuote } : stock;
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
      </View>

      <View style={styles.assetTypeRow}>
        <TouchableOpacity
          style={[
            styles.assetTypeButton,
            { borderColor: PipelineColors.bullish },
            selectedAssetType === 'Stock' && { backgroundColor: PipelineColors.bullish },
          ]}
          onPress={() => setSelectedAssetType('Stock')}>
          <Text style={styles.assetTypeButtonText}>Stock</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.assetTypeButton,
            { borderColor: PipelineColors.core },
            selectedAssetType === 'ETF' && { backgroundColor: PipelineColors.core },
          ]}
          onPress={() => setSelectedAssetType('ETF')}>
          <Text style={styles.assetTypeButtonText}>ETF</Text>
        </TouchableOpacity>
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
          renderItem={renderStockCard}
          initialNumToRender={10}
          windowSize={5}
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
    marginBottom: 8,
    gap: 8,
    zIndex: 10,
  },
  assetTypeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
    gap: 8,
  },
  assetTypeButton: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  assetTypeButtonText: {
    color: PipelineColors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
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
