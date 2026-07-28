import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import type { Stock } from '@/components/StockCard';
import { TickerAutocomplete } from '@/components/TickerAutocomplete';
import { PipelineColors } from '@/constants/pipeline-colors';
import { PORTFOLIO_TICKERS_STORAGE_KEY } from '@/constants/storage-keys';
import { TRAILING_STOP_MULTIPLIER } from '@/constants/thresholds';
import { fetchStockData } from '@/services/api';
import type { AssetType } from '@/types/asset';
import type { PortfolioCategory, PortfolioStock, PortfolioTickerEntry } from '@/types/portfolio';
import { loadAmbushTickerEntries } from '@/utils/ambush-storage';
import { formatAmbushLines, formatPortfolioLines } from '@/utils/report-formatters';
import { normalizeTickerInput } from '@/utils/ticker';

type FilterOption = 'All' | PortfolioCategory;
const FILTER_OPTIONS: FilterOption[] = ['All', 'Core', 'Satellite', 'Quality'];

// Tracks the "Highest Watermark" (highest price seen since a Stock position
// was added) that drives the trailing-stop trigger price. Only meaningful
// for 'Stock' assets — ETFs are judged against SMA200 elsewhere, not a
// trailing stop.
function computeHighestWatermark(
  assetType: AssetType,
  previousWatermark: number | null,
  latestPrice: number,
): number | null {
  if (assetType !== 'Stock') {
    return null;
  }
  return previousWatermark === null ? latestPrice : Math.max(previousWatermark, latestPrice);
}

// The Fortress 2.0 Model: a 70/20/10 allocation across Core, Satellites, and
// Quality positions.
export default function PortfolioScreen() {
  const [stocks, setStocks] = useState<PortfolioStock[]>([]);
  const [ticker, setTicker] = useState('');
  const [units, setUnits] = useState('1');
  const [selectedCategory, setSelectedCategory] = useState<PortfolioCategory>('Core');
  const [selectedAssetType, setSelectedAssetType] = useState<AssetType>('Stock');
  const [activeFilter, setActiveFilter] = useState<FilterOption>('All');
  const [isAdding, setIsAdding] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isExportingAll, setIsExportingAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Load the saved portfolio on mount: read the ticker/category pairs from
  // AsyncStorage, then fetch a fresh live price for each from the Python API.
  useEffect(() => {
    let isMounted = true;

    async function loadInitialStocks() {
      let entries: PortfolioTickerEntry[];
      try {
        const stored = await AsyncStorage.getItem(PORTFOLIO_TICKERS_STORAGE_KEY);
        const parsed = stored ? (JSON.parse(stored) as Partial<PortfolioTickerEntry>[]) : [];
        // Entries saved before "units", "assetType", or "highestWatermark"
        // existed won't have valid values; backfill them rather than
        // letting totals/trailing-stop math break on undefined/NaN.
        entries = parsed.map((entry) => ({
          ticker: entry.ticker ?? '',
          category: entry.category ?? 'Core',
          units: typeof entry.units === 'number' && entry.units > 0 ? entry.units : 1,
          assetType: entry.assetType === 'ETF' ? 'ETF' : 'Stock',
          highestWatermark:
            typeof entry.highestWatermark === 'number' ? entry.highestWatermark : null,
        }));
      } catch {
        entries = [];
      }

      const results = await Promise.allSettled(entries.map((entry) => fetchStockData(entry.ticker)));

      const loadedStocks: PortfolioStock[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const entry = entries[index];
          loadedStocks.push({
            ...entry,
            price: result.value.price,
            highestWatermark: computeHighestWatermark(
              entry.assetType,
              entry.highestWatermark,
              result.value.price,
            ),
          });
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

    const entries: PortfolioTickerEntry[] = stocks.map(
      ({ ticker: symbol, category, assetType, units: unitCount, highestWatermark }) => ({
        ticker: symbol,
        category,
        assetType,
        units: unitCount,
        highestWatermark,
      }),
    );
    AsyncStorage.setItem(PORTFOLIO_TICKERS_STORAGE_KEY, JSON.stringify(entries)).catch((error) => {
      console.warn('Failed to save portfolio to storage:', error);
    });
  }, [stocks, isInitializing]);

  const handleAddTicker = async () => {
    const normalizedTicker = normalizeTickerInput(ticker);
    if (!normalizedTicker || isAdding) {
      return;
    }

    const parsedUnits = Number(units);
    if (!Number.isFinite(parsedUnits) || parsedUnits <= 0) {
      Alert.alert('Invalid Units', 'Please enter a positive number of units.');
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
        {
          ticker: normalizedTicker,
          category: selectedCategory,
          assetType: selectedAssetType,
          units: parsedUnits,
          price: quote.price,
          highestWatermark: computeHighestWatermark(selectedAssetType, null, quote.price),
        },
      ]);
      setTicker('');
      setUnits('1');
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

  const handleSaveEdit = (tickerToUpdate: string, newUnits: number, newAssetType: AssetType) => {
    setStocks((prevStocks) =>
      prevStocks.map((stock) => {
        if (stock.ticker !== tickerToUpdate) {
          return stock;
        }

        let highestWatermark: number | null;
        if (newAssetType !== 'Stock') {
          highestWatermark = null;
        } else if (stock.assetType === 'Stock' && stock.highestWatermark !== null) {
          highestWatermark = stock.highestWatermark;
        } else {
          // Just became a Stock position (or never had a watermark yet) —
          // start tracking from the current price.
          highestWatermark = stock.price;
        }

        return { ...stock, units: newUnits, assetType: newAssetType, highestWatermark };
      }),
    );
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const tickersToRefresh = stocks.map((stock) => stock.ticker);
      const results = await Promise.allSettled(tickersToRefresh.map((t) => fetchStockData(t)));

      const freshPrices = new Map<string, number>();
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          freshPrices.set(tickersToRefresh[index], result.value.price);
        }
      });

      setStocks((prevStocks) =>
        prevStocks.map((stock) => {
          const freshPrice = freshPrices.get(stock.ticker);
          if (freshPrice === undefined) {
            return stock;
          }
          return {
            ...stock,
            price: freshPrice,
            highestWatermark: computeHighestWatermark(
              stock.assetType,
              stock.highestWatermark,
              freshPrice,
            ),
          };
        }),
      );
    } finally {
      setRefreshing(false);
    }
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
      const ambushEntries = (await loadAmbushTickerEntries()) ?? [];

      const ambushResults = await Promise.allSettled(
        ambushEntries.map((entry) => fetchStockData(entry.ticker)),
      );

      const ambushStocks: Stock[] = [];
      ambushResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          ambushStocks.push({ ...ambushEntries[index], ...result.value });
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

  const showCoreSection = activeFilter === 'All' || activeFilter === 'Core';
  const showSatelliteSection = activeFilter === 'All' || activeFilter === 'Satellite';
  const showQualitySection = activeFilter === 'All' || activeFilter === 'Quality';

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
        <TextInput
          style={styles.unitsInput}
          value={units}
          onChangeText={setUnits}
          placeholder="Units"
          placeholderTextColor={PipelineColors.textSecondary}
          keyboardType="numeric"
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

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
        contentContainerStyle={styles.filterRow}>
        {FILTER_OPTIONS.map((filterOption) => (
          <TouchableOpacity
            key={filterOption}
            style={[styles.filterButton, activeFilter === filterOption && styles.filterButtonActive]}
            onPress={() => setActiveFilter(filterOption)}>
            <Text
              style={[
                styles.filterButtonText,
                activeFilter === filterOption && styles.filterButtonTextActive,
              ]}>
              {filterOption}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {isInitializing ? (
        <View style={styles.initializingContainer}>
          <ActivityIndicator size="large" color={PipelineColors.textPrimary} />
          <Text style={styles.initializingText}>Loading your portfolio...</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={PipelineColors.textPrimary}
            />
          }>
          {showCoreSection && (
            <PortfolioSection
              title="Core (70%)"
              accentColor={PipelineColors.core}
              stocks={coreStocks}
              onDelete={handleDeleteTicker}
              onSaveEdit={handleSaveEdit}
            />
          )}
          {showSatelliteSection && (
            <PortfolioSection
              title="Satellite (20%)"
              accentColor={PipelineColors.satellite}
              stocks={satelliteStocks}
              onDelete={handleDeleteTicker}
              onSaveEdit={handleSaveEdit}
            />
          )}
          {showQualitySection && (
            <PortfolioSection
              title="Quality (10%)"
              accentColor={PipelineColors.quality}
              stocks={qualityStocks}
              onDelete={handleDeleteTicker}
              onSaveEdit={handleSaveEdit}
            />
          )}
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
  onSaveEdit: (ticker: string, units: number, assetType: AssetType) => void;
};

function PortfolioSection({ title, accentColor, stocks, onDelete, onSaveEdit }: PortfolioSectionProps) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: accentColor }]}>{title}</Text>
      {stocks.length === 0 ? (
        <Text style={styles.sectionEmptyText}>No positions yet.</Text>
      ) : (
        stocks.map((stock) => (
          <PortfolioStockRow
            key={stock.ticker}
            stock={stock}
            accentColor={accentColor}
            onDelete={onDelete}
            onSaveEdit={onSaveEdit}
          />
        ))
      )}
    </View>
  );
}

type PortfolioStockRowProps = {
  stock: PortfolioStock;
  accentColor: string;
  onDelete: (ticker: string) => void;
  onSaveEdit: (ticker: string, units: number, assetType: AssetType) => void;
};

function PortfolioStockRow({ stock, accentColor, onDelete, onSaveEdit }: PortfolioStockRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [unitsText, setUnitsText] = useState(String(stock.units));
  const [editedAssetType, setEditedAssetType] = useState<AssetType>(stock.assetType);

  const totalValue = stock.units * stock.price;
  const trailingStopPrice =
    stock.assetType === 'Stock' && stock.highestWatermark !== null
      ? stock.highestWatermark * TRAILING_STOP_MULTIPLIER
      : null;
  const isTrailingStopTriggered = trailingStopPrice !== null && stock.price <= trailingStopPrice;

  const handleStartEditing = () => {
    setUnitsText(String(stock.units));
    setEditedAssetType(stock.assetType);
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    const parsedUnits = Number(unitsText);
    if (!Number.isFinite(parsedUnits) || parsedUnits <= 0) {
      Alert.alert('Invalid Units', 'Please enter a positive number of units.');
      return;
    }
    onSaveEdit(stock.ticker, parsedUnits, editedAssetType);
    setIsEditing(false);
  };

  return (
    <View style={styles.stockCard}>
      <View style={styles.stockTopRow}>
        <Text style={styles.stockTicker}>{stock.ticker}</Text>
        <View style={styles.stockTopRight}>
          <View style={styles.assetTypeBadge}>
            <Text style={styles.assetTypeBadgeText}>{stock.assetType}</Text>
          </View>
          <View style={[styles.categoryBadge, { backgroundColor: accentColor }]}>
            <Text style={styles.categoryBadgeText}>{stock.category}</Text>
          </View>
          <TouchableOpacity
            onPress={() => onDelete(stock.ticker)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={`Remove ${stock.ticker} from portfolio`}>
            <Text style={styles.deleteButtonText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      {isEditing ? (
        <View style={styles.editContainer}>
          <View style={styles.unitsEditRow}>
            <TextInput
              style={styles.unitsEditInput}
              value={unitsText}
              onChangeText={setUnitsText}
              keyboardType="numeric"
              autoFocus
              selectTextOnFocus
              onSubmitEditing={handleSaveEdit}
            />
            <TouchableOpacity
              onPress={handleSaveEdit}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel={`Save changes for ${stock.ticker}`}>
              <Ionicons name="checkmark" size={20} color={PipelineColors.bullish} />
            </TouchableOpacity>
          </View>
          <View style={styles.editAssetTypeRow}>
            <TouchableOpacity
              style={[
                styles.editAssetTypeButton,
                { borderColor: PipelineColors.bullish },
                editedAssetType === 'Stock' && { backgroundColor: PipelineColors.bullish },
              ]}
              onPress={() => setEditedAssetType('Stock')}>
              <Text style={styles.editAssetTypeButtonText}>Stock</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.editAssetTypeButton,
                { borderColor: PipelineColors.core },
                editedAssetType === 'ETF' && { backgroundColor: PipelineColors.core },
              ]}
              onPress={() => setEditedAssetType('ETF')}>
              <Text style={styles.editAssetTypeButtonText}>ETF</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.stockBottomRow}>
          <View style={styles.unitsDisplayRow}>
            <Text style={styles.stockDetailText}>
              {stock.units} unit{stock.units === 1 ? '' : 's'} @ ${stock.price.toFixed(2)}
            </Text>
            <TouchableOpacity
              onPress={handleStartEditing}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel={`Edit ${stock.ticker}`}>
              <Ionicons name="pencil" size={14} color={PipelineColors.textSecondary} />
            </TouchableOpacity>
          </View>
          <Text style={styles.stockTotalValue}>${totalValue.toFixed(2)}</Text>
        </View>
      )}

      {!isEditing && trailingStopPrice !== null && (
        <Text
          style={[
            styles.trailingStopText,
            isTrailingStopTriggered && styles.trailingStopTriggeredText,
          ]}>
          {isTrailingStopTriggered ? '⚠ ' : ''}TS Triggered at: ${trailingStopPrice.toFixed(2)}
        </Text>
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
  unitsInput: {
    width: 70,
    backgroundColor: PipelineColors.cardBackground,
    color: PipelineColors.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    textAlign: 'center',
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
  assetTypeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
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
  filterScroll: {
    flexGrow: 0,
    marginBottom: 12,
  },
  filterRow: {
    paddingHorizontal: 16,
    gap: 8,
  },
  filterButton: {
    backgroundColor: PipelineColors.cardBackground,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  filterButtonActive: {
    backgroundColor: PipelineColors.textPrimary,
  },
  filterButtonText: {
    color: PipelineColors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  filterButtonTextActive: {
    color: PipelineColors.background,
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
  stockCard: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PipelineColors.background,
  },
  stockTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stockTopRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stockTicker: {
    flex: 1,
    color: PipelineColors.textPrimary,
    fontSize: 16,
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
  categoryBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  categoryBadgeText: {
    color: PipelineColors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  deleteButtonText: {
    color: PipelineColors.bearish,
    fontSize: 16,
    fontWeight: '700',
  },
  stockBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  stockDetailText: {
    color: PipelineColors.textSecondary,
    fontSize: 13,
  },
  stockTotalValue: {
    color: PipelineColors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  unitsDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  editContainer: {
    marginTop: 8,
    gap: 8,
  },
  unitsEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  unitsEditInput: {
    backgroundColor: PipelineColors.background,
    color: PipelineColors.textPrimary,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 13,
    width: 56,
  },
  editAssetTypeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  editAssetTypeButton: {
    borderWidth: 1.5,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  editAssetTypeButtonText: {
    color: PipelineColors.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  trailingStopText: {
    color: PipelineColors.textSecondary,
    fontSize: 12,
    marginTop: 6,
  },
  trailingStopTriggeredText: {
    color: PipelineColors.warning,
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
