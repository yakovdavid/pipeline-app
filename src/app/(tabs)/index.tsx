import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import type { Stock } from '@/components/StockCard';
import { TickerAutocomplete } from '@/components/TickerAutocomplete';
import { PipelineColors } from '@/constants/pipeline-colors';
import { AMBUSH_TICKERS_STORAGE_KEY, PORTFOLIO_TICKERS_STORAGE_KEY } from '@/constants/storage-keys';
import { fetchStockData } from '@/services/api';
import type { PortfolioCategory, PortfolioStock, PortfolioTickerEntry } from '@/types/portfolio';
import { formatAmbushLines, formatPortfolioLines } from '@/utils/report-formatters';

// The Fortress 2.0 Model: a 70/20/10 allocation across Core, Satellites, and
// Quality positions.
export default function PortfolioScreen() {
  const [stocks, setStocks] = useState<PortfolioStock[]>([]);
  const [ticker, setTicker] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<PortfolioCategory>('Core');
  const [isAdding, setIsAdding] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isExportingAll, setIsExportingAll] = useState(false);

  // Load the saved portfolio on mount: read the ticker/category pairs from
  // AsyncStorage, then fetch a fresh live price for each from the Python API.
  useEffect(() => {
    let isMounted = true;

    async function loadInitialStocks() {
      let entries: PortfolioTickerEntry[];
      try {
        const stored = await AsyncStorage.getItem(PORTFOLIO_TICKERS_STORAGE_KEY);
        entries = stored ? (JSON.parse(stored) as PortfolioTickerEntry[]) : [];
      } catch {
        entries = [];
      }

      const results = await Promise.allSettled(entries.map((entry) => fetchStockData(entry.ticker)));

      const loadedStocks: PortfolioStock[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          loadedStocks.push({ ...entries[index], price: result.value.price });
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

  // Keep AsyncStorage in sync with the current portfolio. Skipped while
  // initializing so we don't overwrite storage before the saved list loads.
  useEffect(() => {
    if (isInitializing) {
      return;
    }

    const entries: PortfolioTickerEntry[] = stocks.map(({ ticker: symbol, category }) => ({
      ticker: symbol,
      category,
    }));
    AsyncStorage.setItem(PORTFOLIO_TICKERS_STORAGE_KEY, JSON.stringify(entries)).catch((error) => {
      console.warn('Failed to save portfolio to storage:', error);
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
      setStocks((prevStocks) => [
        ...prevStocks,
        { ticker: normalizedTicker, category: selectedCategory, price: quote.price },
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

  const handleDeleteTicker = (tickerToDelete: string) => {
    setStocks((prevStocks) => prevStocks.filter((stock) => stock.ticker !== tickerToDelete));
  };

  const handleCopyPortfolioData = async () => {
    const timestamp = new Date().toLocaleString();
    const report = [`Pipeline Portfolio Report — ${timestamp}`, '', ...formatPortfolioLines(stocks)].join(
      '\n',
    );

    try {
      await Clipboard.setStringAsync(report);
      Alert.alert('Copied', 'Portfolio data copied to clipboard.');
    } catch {
      Alert.alert('Copy Failed', 'Could not copy Portfolio data to the clipboard.');
    }
  };

  const handleCopyAllData = async () => {
    setIsExportingAll(true);
    try {
      const storedAmbushTickers = await AsyncStorage.getItem(AMBUSH_TICKERS_STORAGE_KEY);
      const ambushTickers: string[] = storedAmbushTickers ? JSON.parse(storedAmbushTickers) : [];

      const ambushResults = await Promise.allSettled(
        ambushTickers.map((ambushTicker) => fetchStockData(ambushTicker)),
      );

      const ambushStocks: Stock[] = [];
      ambushResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          ambushStocks.push({ ticker: ambushTickers[index], ...result.value });
        }
      });

      const timestamp = new Date().toLocaleString();
      const report = [
        `Pipeline Full Data Export — ${timestamp}`,
        '',
        '=== PORTFOLIO ===',
        ...formatPortfolioLines(stocks),
        '',
        '=== AMBUSH RADAR ===',
        ...formatAmbushLines(ambushStocks),
      ].join('\n');

      await Clipboard.setStringAsync(report);
      Alert.alert('Copied', 'Combined Portfolio and Ambush Radar data copied to clipboard.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build the combined data export.';
      Alert.alert('Copy Failed', message);
    } finally {
      setIsExportingAll(false);
    }
  };

  const coreStocks = stocks.filter((stock) => stock.category === 'Core');
  const satelliteStocks = stocks.filter((stock) => stock.category === 'Satellite');
  const qualityStocks = stocks.filter((stock) => stock.category === 'Quality');

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Portfolio</Text>
      </View>

      <View style={styles.exportRow}>
        <TouchableOpacity style={styles.exportButton} onPress={handleCopyPortfolioData}>
          <Text style={styles.exportButtonText}>Copy Portfolio Data</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.exportButton, isExportingAll && styles.exportButtonDisabled]}
          onPress={handleCopyAllData}
          disabled={isExportingAll}>
          {isExportingAll ? (
            <ActivityIndicator size="small" color={PipelineColors.textPrimary} />
          ) : (
            <Text style={styles.exportButtonText}>Copy ALL Data</Text>
          )}
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

      <View style={styles.categoryRow}>
        <TouchableOpacity
          style={[
            styles.categoryButton,
            { borderColor: PipelineColors.core },
            selectedCategory === 'Core' && { backgroundColor: PipelineColors.core },
          ]}
          onPress={() => setSelectedCategory('Core')}>
          <Text style={styles.categoryButtonText}>Core</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.categoryButton,
            { borderColor: PipelineColors.satellite },
            selectedCategory === 'Satellite' && { backgroundColor: PipelineColors.satellite },
          ]}
          onPress={() => setSelectedCategory('Satellite')}>
          <Text style={styles.categoryButtonText}>Satellite</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.categoryButton,
            { borderColor: PipelineColors.quality },
            selectedCategory === 'Quality' && { backgroundColor: PipelineColors.quality },
          ]}
          onPress={() => setSelectedCategory('Quality')}>
          <Text style={styles.categoryButtonText}>Quality</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.addRow}>
        <TouchableOpacity
          style={[styles.addButton, isAdding && styles.addButtonDisabled]}
          onPress={handleAddTicker}
          disabled={isAdding}>
          {isAdding ? (
            <ActivityIndicator size="small" color={PipelineColors.textPrimary} />
          ) : (
            <Text style={styles.addButtonText}>Add to Portfolio</Text>
          )}
        </TouchableOpacity>
      </View>

      {isInitializing ? (
        <View style={styles.initializingContainer}>
          <ActivityIndicator size="large" color={PipelineColors.textPrimary} />
          <Text style={styles.initializingText}>Loading your portfolio...</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.listContent}>
          <PortfolioSection
            title="Core (70%)"
            accentColor={PipelineColors.core}
            stocks={coreStocks}
            onDelete={handleDeleteTicker}
          />
          <PortfolioSection
            title="Satellite (20%)"
            accentColor={PipelineColors.satellite}
            stocks={satelliteStocks}
            onDelete={handleDeleteTicker}
          />
          <PortfolioSection
            title="Quality (10%)"
            accentColor={PipelineColors.quality}
            stocks={qualityStocks}
            onDelete={handleDeleteTicker}
          />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

type PortfolioSectionProps = {
  title: string;
  accentColor: string;
  stocks: PortfolioStock[];
  onDelete: (ticker: string) => void;
};

function PortfolioSection({ title, accentColor, stocks, onDelete }: PortfolioSectionProps) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: accentColor }]}>{title}</Text>
      {stocks.length === 0 ? (
        <Text style={styles.sectionEmptyText}>No positions yet.</Text>
      ) : (
        stocks.map((stock) => (
          <View key={stock.ticker} style={styles.stockRow}>
            <View style={[styles.categoryDot, { backgroundColor: accentColor }]} />
            <Text style={styles.stockTicker}>{stock.ticker}</Text>
            <Text style={styles.stockPrice}>${stock.price.toFixed(2)}</Text>
            <TouchableOpacity
              onPress={() => onDelete(stock.ticker)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel={`Remove ${stock.ticker} from portfolio`}>
              <Text style={styles.deleteButtonText}>✕</Text>
            </TouchableOpacity>
          </View>
        ))
      )}
    </View>
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
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginBottom: 12,
    gap: 8,
  },
  exportButton: {
    flex: 1,
    backgroundColor: PipelineColors.cardBackground,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  exportButtonDisabled: {
    opacity: 0.6,
  },
  exportButtonText: {
    color: PipelineColors.textPrimary,
    fontSize: 13,
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
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
    gap: 8,
  },
  categoryButton: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryButtonText: {
    color: PipelineColors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  addRow: {
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  addButton: {
    backgroundColor: PipelineColors.bullish,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
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
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  section: {
    backgroundColor: PipelineColors.cardBackground,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
  },
  sectionEmptyText: {
    color: PipelineColors.textSecondary,
    fontSize: 14,
  },
  stockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },
  categoryDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  stockTicker: {
    flex: 1,
    color: PipelineColors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  stockPrice: {
    color: PipelineColors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  deleteButtonText: {
    color: PipelineColors.bearish,
    fontSize: 16,
    fontWeight: '700',
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
