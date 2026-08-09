import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { PullToRefreshLogo } from '@/components/PullToRefreshLogo';
import type { Stock } from '@/components/StockCard';
import { TickerAutocomplete } from '@/components/TickerAutocomplete';
import { PipelineColors } from '@/constants/pipeline-colors';
import { PORTFOLIO_TICKERS_STORAGE_KEY } from '@/constants/storage-keys';
import { SATELLITE_ETF_TS_PCT, SATELLITE_STOCK_TS_PCT } from '@/constants/thresholds';
import { fetchIntel, fetchStockData, type IntelBatchResponse, type StockQuote } from '@/services/api';
import type { AssetType } from '@/types/asset';
import type { PortfolioCategory, PortfolioStock, PortfolioTickerEntry } from '@/types/portfolio';
import { loadAmbushTickerEntries } from '@/utils/ambush-storage';
import { createBackupPayload, parseBackupPayload, restoreBackupPayload, type BackupPayload } from '@/utils/backup';
import { formatAmbushLines, formatPortfolioLines } from '@/utils/report-formatters';
import { normalizeTickerInput } from '@/utils/ticker';

type FilterOption = 'All' | PortfolioCategory;
const FILTER_OPTIONS: FilterOption[] = ['All', 'Core', 'Satellite', 'Quality'];

// Snap points for the Intel modal's draggable bottom sheet, expressed as
// pixel heights (not percentages) so PanResponder math below can work with
// them directly. Drag up from the handle to expand toward MAX; releasing
// snaps to whichever of DEFAULT/MAX is closer, it never snaps shut — the
// modal only closes via the explicit close button (see the previous
// backdrop-tap-to-dismiss fix).
const SCREEN_HEIGHT = Dimensions.get('window').height;
const INTEL_SHEET_MIN_HEIGHT = SCREEN_HEIGHT * 0.4;
const INTEL_SHEET_DEFAULT_HEIGHT = SCREEN_HEIGHT * 0.6;
const INTEL_SHEET_MAX_HEIGHT = SCREEN_HEIGHT * 0.9;

type PortfolioListSection = {
  title: string;
  category: PortfolioCategory;
  accentColor: string;
  data: PortfolioStock[];
};

// Module-level (not defined inside the component) since these have no
// closure dependencies — a stable identity across renders, same reasoning
// as the useCallback-wrapped handlers below.
function extractPortfolioItemKey(item: PortfolioStock): string {
  return item.ticker;
}

function renderPortfolioSectionHeader({ section }: { section: PortfolioListSection }) {
  return <Text style={[styles.sectionTitle, { color: section.accentColor }]}>{section.title}</Text>;
}

function renderPortfolioSectionFooter({ section }: { section: PortfolioListSection }) {
  return section.data.length === 0 ? (
    <Text style={styles.sectionEmptyText}>No positions yet.</Text>
  ) : null;
}

// Tracks the "Highest Watermark" (highest price seen since a position was
// added) that drives the Satellite trailing-stop trigger price for both
// Stock and ETF positions (see the TS_PCT bifurcation in PortfolioStockRow
// below). Tracked for every position regardless of category/assetType —
// category isn't available here, and it's harmless to also track it for
// Core/Quality positions that never actually use it for a TS calculation.
function computeHighestWatermark(previousWatermark: number | null, latestPrice: number): number | null {
  return previousWatermark === null ? latestPrice : Math.max(previousWatermark, latestPrice);
}

// TS bifurcation: only called for Satellite positions (see
// PortfolioStockRow) — ETFs get a tighter trailing stop than Stocks since
// they're structurally less volatile.
function getSatelliteTrailingStopPct(assetType: AssetType): number {
  return assetType === 'ETF' ? SATELLITE_ETF_TS_PCT : SATELLITE_STOCK_TS_PCT;
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
  const [isMenuVisible, setIsMenuVisible] = useState(false);
  const [isAddModalVisible, setIsAddModalVisible] = useState(false);
  const [isExportingBackup, setIsExportingBackup] = useState(false);
  const [isImportModalVisible, setIsImportModalVisible] = useState(false);
  const [importText, setImportText] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const [isIntelModalVisible, setIsIntelModalVisible] = useState(false);
  // Raw, comma-separated user input (e.g. "PLD, UNH, AMT") — the backend
  // does the actual per-ticker splitting/trimming, so this is sent as-is.
  const [intelInput, setIntelInput] = useState('');
  const [intelResult, setIntelResult] = useState<IntelBatchResponse | null>(null);
  const [isFetchingIntel, setIsFetchingIntel] = useState(false);

  const insets = useSafeAreaInsets();

  // Drives the Intel modal's draggable bottom sheet height. Lazily
  // initialized via useState (not useRef().current) so the value stays
  // stable across renders without reading a ref during render — the
  // Animated.Value itself is still a mutable object updated imperatively
  // via setValue/spring, same as the useRef version would have been.
  const [intelSheetHeight] = useState(() => new Animated.Value(INTEL_SHEET_DEFAULT_HEIGHT));
  // Snapshots the sheet's height at the start of each drag (via
  // stopAnimation, read directly off the live Animated.Value) so
  // onPanResponderMove can compute each frame's height from a fixed
  // baseline instead of compounding off the previous frame's already-updated
  // value. Only ever read/written from event handlers, never during render.
  const gestureStartHeightRef = useRef(INTEL_SHEET_DEFAULT_HEIGHT);

  // The linter can't tell that PanResponder's handler object only reads
  // gestureStartHeightRef.current from inside gesture callbacks (invoked
  // later, off the render path) rather than during this initializer's own
  // execution — PanResponder isn't a recognized event-handler shape to it.
  // eslint-disable-next-line react-hooks/refs
  const [intelSheetPanResponder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 4,
      onPanResponderGrant: () => {
        intelSheetHeight.stopAnimation((value) => {
          gestureStartHeightRef.current = value;
        });
      },
      onPanResponderMove: (_event, gesture) => {
        // Dragging up (negative dy) grows the sheet; dragging down shrinks it.
        const nextHeight = Math.min(
          INTEL_SHEET_MAX_HEIGHT,
          Math.max(INTEL_SHEET_MIN_HEIGHT, gestureStartHeightRef.current - gesture.dy),
        );
        intelSheetHeight.setValue(nextHeight);
      },
      onPanResponderRelease: (_event, gesture) => {
        const releasedHeight = Math.min(
          INTEL_SHEET_MAX_HEIGHT,
          Math.max(INTEL_SHEET_MIN_HEIGHT, gestureStartHeightRef.current - gesture.dy),
        );
        const midpoint = (INTEL_SHEET_MIN_HEIGHT + INTEL_SHEET_MAX_HEIGHT) / 2;
        Animated.spring(intelSheetHeight, {
          toValue: releasedHeight > midpoint ? INTEL_SHEET_MAX_HEIGHT : INTEL_SHEET_DEFAULT_HEIGHT,
          useNativeDriver: false,
          bounciness: 4,
        }).start();
      },
    }),
  );

  // Reset to the default snap point every time the modal is (re)opened,
  // rather than reopening wherever the user last dragged it to.
  useEffect(() => {
    if (isIntelModalVisible) {
      intelSheetHeight.setValue(INTEL_SHEET_DEFAULT_HEIGHT);
    }
  }, [isIntelModalVisible, intelSheetHeight]);

  // Load the saved portfolio on mount: read the ticker/category pairs from
  // AsyncStorage, then fetch a fresh live price for each from the Python API.
  useEffect(() => {
    let isMounted = true;

    async function loadInitialStocks() {
      // Hydration hardening: a storage read/parse failure must NOT be
      // treated the same as "the user has no saved positions" — the old
      // code's `catch { entries = [] }` did exactly that, which then flowed
      // straight into setStocks([]) and, via the persistence effect below,
      // permanently overwrote real portfolio data in storage with an empty
      // array on a mere transient AsyncStorage/JSON error.
      let entries: PortfolioTickerEntry[];
      try {
        const stored = await AsyncStorage.getItem(PORTFOLIO_TICKERS_STORAGE_KEY);
        const parsed = stored ? (JSON.parse(stored) as Partial<PortfolioTickerEntry>[]) : [];
        if (!Array.isArray(parsed)) {
          throw new Error('Stored portfolio data is not an array.');
        }
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
      } catch (error) {
        console.error(
          '[hydration] Failed to read the Portfolio from storage; retaining the previous ' +
            'state instead of overwriting it with an empty portfolio.',
          error,
        );
        if (isMounted) {
          setIsInitializing(false);
        }
        return;
      }

      if (entries.length === 0) {
        // A genuinely empty, successfully-read portfolio (the user deleted
        // every position) is valid state, not a failure — show it as-is.
        if (isMounted) {
          setStocks([]);
          setIsInitializing(false);
        }
        return;
      }

      const results = await Promise.allSettled(entries.map((entry) => fetchStockData(entry.ticker)));

      const loadedStocks: PortfolioStock[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const entry = entries[index];
          loadedStocks.push({
            ...entry,
            price: result.value.price,
            anomalyReport: result.value.anomalyReport,
            high52: result.value.high52,
            drawdownPct: result.value.drawdownPct,
            highestWatermark: computeHighestWatermark(entry.highestWatermark, result.value.price),
          });
        }
      });

      if (loadedStocks.length === 0) {
        // Every single live-quote fetch failed — almost certainly a
        // network outage, not "these positions don't exist". The storage
        // read above succeeded and returned real entries, so replacing
        // them with an empty list here would trigger the exact data-loss
        // bug being fixed via the persistence effect below.
        console.error(
          `[hydration] All ${entries.length} position fetch(es) failed (network issue?); ` +
            'retaining the previous portfolio instead of clearing it.',
        );
        if (isMounted) {
          setIsInitializing(false);
        }
        return;
      }

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
          anomalyReport: quote.anomalyReport,
          high52: quote.high52,
          drawdownPct: quote.drawdownPct,
          highestWatermark: computeHighestWatermark(null, quote.price),
        },
      ]);
      setTicker('');
      setUnits('1');
      setIsAddModalVisible(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to fetch data for ${normalizedTicker}.`;
      Alert.alert('Could Not Add Ticker', message);
    } finally {
      setIsAdding(false);
    }
  };

  // Stable identity (useCallback) is required for the React.memo on
  // PortfolioStockRow to actually skip re-renders — an inline function here
  // would be a new reference on every PortfolioScreen render, which would
  // defeat memo() by changing this prop for every row on every render.
  const handleDeleteTicker = useCallback((tickerToDelete: string) => {
    setStocks((prevStocks) => prevStocks.filter((stock) => stock.ticker !== tickerToDelete));
  }, []);

  const handleSaveEdit = useCallback(
    (tickerToUpdate: string, newUnits: number, newAssetType: AssetType) => {
      setStocks((prevStocks) =>
        prevStocks.map((stock) => {
          if (stock.ticker !== tickerToUpdate) {
            return stock;
          }

          // The watermark is now tracked for every asset type (Satellite
          // ETFs need it for their own trailing stop too — see
          // SATELLITE_ETF_TS_PCT), so switching between Stock and ETF no
          // longer resets it: keep whatever was already being tracked, or
          // seed it from the current price if this position never had one.
          const highestWatermark = stock.highestWatermark ?? stock.price;

          return { ...stock, units: newUnits, assetType: newAssetType, highestWatermark };
        }),
      );
    },
    [],
  );

  const renderPortfolioRow = useCallback(
    ({ item, section }: { item: PortfolioStock; section: PortfolioListSection }) => (
      <PortfolioStockRow
        stock={item}
        accentColor={section.accentColor}
        onDelete={handleDeleteTicker}
        onSaveEdit={handleSaveEdit}
      />
    ),
    [handleDeleteTicker, handleSaveEdit],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const tickersToRefresh = stocks.map((stock) => stock.ticker);
      const results = await Promise.allSettled(tickersToRefresh.map((t) => fetchStockData(t)));

      const freshQuotes = new Map<string, StockQuote>();
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          freshQuotes.set(tickersToRefresh[index], result.value);
        }
      });

      setStocks((prevStocks) =>
        prevStocks.map((stock) => {
          const freshQuote = freshQuotes.get(stock.ticker);
          if (!freshQuote) {
            return stock;
          }
          return {
            ...stock,
            price: freshQuote.price,
            anomalyReport: freshQuote.anomalyReport,
            high52: freshQuote.high52,
            drawdownPct: freshQuote.drawdownPct,
            highestWatermark: computeHighestWatermark(stock.highestWatermark, freshQuote.price),
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

  const handleExportBackup = async () => {
    setIsExportingBackup(true);
    try {
      const payload = await createBackupPayload();
      await Clipboard.setStringAsync(JSON.stringify(payload));
      Alert.alert(
        'Backup Exported',
        'Your Portfolio and Ambush Radar data has been copied to the clipboard as JSON. Paste it somewhere safe.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to export backup.';
      Alert.alert('Export Failed', message);
    } finally {
      setIsExportingBackup(false);
    }
  };

  const handleRestoreBackup = async () => {
    let payload: BackupPayload;
    try {
      payload = parseBackupPayload(importText);
    } catch (error) {
      // Strict, on purpose: abort entirely rather than attempt a partial
      // restore from a backup we can't fully trust.
      const message = error instanceof Error ? error.message : 'The pasted text is not a valid backup.';
      Alert.alert('Invalid Backup', message);
      return;
    }

    setIsRestoring(true);
    try {
      await restoreBackupPayload(payload);

      // Update this screen's own live state immediately (mirrors the
      // initial-load flow); Ambush Radar's separate mounted screen picks up
      // its half of the restore the next time its tab gains focus.
      const results = await Promise.allSettled(
        payload.portfolio.map((entry) => fetchStockData(entry.ticker)),
      );

      const hydratedStocks: PortfolioStock[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const entry = payload.portfolio[index];
          hydratedStocks.push({
            ...entry,
            price: result.value.price,
            anomalyReport: result.value.anomalyReport,
            high52: result.value.high52,
            drawdownPct: result.value.drawdownPct,
            highestWatermark: computeHighestWatermark(entry.highestWatermark, result.value.price),
          });
        }
      });

      setIsImportModalVisible(false);
      setImportText('');

      if (hydratedStocks.length === 0 && payload.portfolio.length > 0) {
        // Hydration hardening applies here too: storage was already
        // successfully overwritten with the restored data above, but if
        // every live-price fetch for it just failed (network issue right
        // after import), don't also blank out whatever was on screen —
        // that would be the exact same "wipe on failure" bug, just
        // triggered from the import flow instead of app startup.
        console.error(
          `[hydration] Backup restored to storage, but all ${payload.portfolio.length} ` +
            'live price fetch(es) failed; retaining the previously displayed portfolio.',
        );
        Alert.alert(
          'Backup Restored',
          'Your data was saved, but live prices could not be fetched right now. Pull to refresh shortly.',
        );
        return;
      }

      setStocks(hydratedStocks);
      Alert.alert('Backup Restored', 'Your Portfolio and Ambush Radar data has been restored.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restore the backup.';
      Alert.alert('Restore Failed', message);
    } finally {
      setIsRestoring(false);
    }
  };

  const handleFetchIntel = async () => {
    if (!intelInput.trim()) {
      Alert.alert('Ticker Required', 'Please enter at least one ticker symbol.');
      return;
    }

    setIsFetchingIntel(true);
    setIntelResult(null);
    try {
      const result = await fetchIntel(intelInput);
      setIntelResult(result);

      const hasAnyNews = result.results.some((entry) => entry.news.length > 0);
      if (!hasAnyNews) {
        Alert.alert('No News Found', 'No recent news was found for the requested ticker(s).');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch intel.';
      Alert.alert('Intel Fetch Failed', message);
    } finally {
      setIsFetchingIntel(false);
    }
  };

  const handleOpenArticleLink = (url: string) => {
    Linking.openURL(url).catch(() => {
      Alert.alert('Could Not Open Link', 'This article link could not be opened.');
    });
  };

  const handleCopyIntel = async () => {
    if (!intelResult || intelResult.results.length === 0) {
      return;
    }

    const sectionTexts = intelResult.results.map((entry) => {
      const lines: string[] = [`=== ${entry.ticker} ===`];

      if (entry.error) {
        lines.push(`Error: ${entry.error}`);
        return lines.join('\n');
      }

      if (entry.news.length === 0) {
        lines.push('No news found.');
        return lines.join('\n');
      }

      entry.news.forEach((article, index) => {
        if (index > 0) {
          lines.push('');
        }
        if (article.isCritical) {
          lines.push(article.tag || '[CRITICAL ALERT]');
        }
        lines.push(`Title: ${article.title}`);
        lines.push(`Source: ${article.publisher} | ${article.publishedAt}`);
        lines.push(`URL: ${article.link || 'N/A'}`);
      });

      return lines.join('\n');
    });

    const text = sectionTexts.join('\n\n');

    try {
      await Clipboard.setStringAsync(text);
      Alert.alert('Copied', 'Intel headlines copied to clipboard.');
    } catch {
      Alert.alert('Copy Failed', 'Could not copy intel to the clipboard.');
    }
  };

  const allSections: PortfolioListSection[] = [
    {
      title: 'Core (70%)',
      category: 'Core',
      accentColor: PipelineColors.core,
      data: stocks.filter((stock) => stock.category === 'Core'),
    },
    {
      title: 'Satellite (20%)',
      category: 'Satellite',
      accentColor: PipelineColors.satellite,
      data: stocks.filter((stock) => stock.category === 'Satellite'),
    },
    {
      title: 'Quality (10%)',
      category: 'Quality',
      accentColor: PipelineColors.quality,
      data: stocks.filter((stock) => stock.category === 'Quality'),
    },
  ];
  const visibleSections = allSections.filter(
    (section) => activeFilter === 'All' || activeFilter === section.category,
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Portfolio</Text>
        <TouchableOpacity
          onPress={() => setIsMenuVisible(true)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="More options">
          <Ionicons name="ellipsis-horizontal" size={24} color={PipelineColors.textPrimary} />
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
          <PullToRefreshLogo isRefreshing overlay={false} />
          <Text style={styles.initializingText}>Loading your portfolio...</Text>
        </View>
      ) : (
        <View style={styles.listWrapper}>
          <PullToRefreshLogo isRefreshing={refreshing} />
          <SectionList
            sections={visibleSections}
            keyExtractor={extractPortfolioItemKey}
            renderItem={renderPortfolioRow}
            renderSectionHeader={renderPortfolioSectionHeader}
            renderSectionFooter={renderPortfolioSectionFooter}
            initialNumToRender={10}
            windowSize={5}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={styles.listContent}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor="transparent"
                colors={['transparent']}
                progressBackgroundColor="transparent"
              />
            }
          />
        </View>
      )}

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setIsAddModalVisible(true)}
        accessibilityLabel="Add asset to portfolio">
        <Ionicons name="add" size={28} color={PipelineColors.textPrimary} />
      </TouchableOpacity>

      <Modal
        visible={isMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIsMenuVisible(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setIsMenuVisible(false)}>
          <View style={styles.menuCard}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setIsMenuVisible(false);
                handleCopyPortfolioData();
              }}>
              <Text style={styles.menuItemText}>Copy Portfolio Data</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity
              style={styles.menuItem}
              disabled={isExportingAll}
              onPress={() => {
                setIsMenuVisible(false);
                handleCopyAllData();
              }}>
              {isExportingAll ? (
                <ActivityIndicator size="small" color={PipelineColors.textPrimary} />
              ) : (
                <Text style={styles.menuItemText}>Copy ALL Data</Text>
              )}
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity
              style={styles.menuItem}
              disabled={isExportingBackup}
              onPress={() => {
                setIsMenuVisible(false);
                handleExportBackup();
              }}>
              {isExportingBackup ? (
                <ActivityIndicator size="small" color={PipelineColors.textPrimary} />
              ) : (
                <Text style={styles.menuItemText}>Export Backup (JSON)</Text>
              )}
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setIsMenuVisible(false);
                setIsImportModalVisible(true);
              }}>
              <Text style={styles.menuItemText}>Import Backup (JSON)</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setIsMenuVisible(false);
                setIsIntelModalVisible(true);
              }}>
              <Text style={styles.menuItemText}>On-Demand Intel</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      <Modal
        visible={isAddModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIsAddModalVisible(false)}>
        <Pressable style={styles.addModalBackdrop} onPress={() => setIsAddModalVisible(false)}>
          {/* iOS 'padding' pads the whole KeyboardAvoidingView, which is
              what pushes this bottom sheet up above the keyboard; Android's
              'height' shrinks it instead (Android's 'padding' behavior
              doesn't play well with a transparent, flex-end Modal here — it
              tends to leave the sheet visually unmoved). */}
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.addModalKeyboardAvoider}>
            {/* TouchableWithoutFeedback so tapping any non-interactive part
                of the sheet (not just the backdrop outside it) dismisses
                the keyboard without closing the whole modal — nested
                TouchableOpacity/TextInput children still get their own taps
                as normal, RN's responder system gives them priority. */}
            <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
              <View style={styles.addAssetModalSheet}>
                <View style={styles.addModalHeader}>
                  <Text style={styles.addModalTitle}>Add Asset</Text>
                  <TouchableOpacity
                    onPress={() => setIsAddModalVisible(false)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityLabel="Close">
                    <Ionicons name="close" size={22} color={PipelineColors.textSecondary} />
                  </TouchableOpacity>
                </View>

                {/* Bounded (addAssetModalSheet has maxHeight) + flex: 1 here
                    is what lets this actually scroll instead of just
                    growing off-screen on a small device once the keyboard
                    eats into the available height. keyboardShouldPersistTaps
                    keeps the category/asset-type/add buttons tappable while
                    the keyboard is still up. */}
                <ScrollView
                  style={styles.addAssetModalScroll}
                  contentContainerStyle={styles.addAssetModalScrollContent}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}>
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

                  <Text style={styles.modalSectionLabel}>Category</Text>
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

                  <Text style={styles.modalSectionLabel}>Asset Type</Text>
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
                </ScrollView>
              </View>
            </TouchableWithoutFeedback>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      <Modal
        visible={isImportModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIsImportModalVisible(false)}>
        <Pressable
          style={styles.addModalBackdrop}
          onPress={() => !isRestoring && setIsImportModalVisible(false)}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.addModalKeyboardAvoider}>
            <View style={styles.addModalSheet}>
              <View style={styles.addModalHeader}>
                <Text style={styles.addModalTitle}>Import Backup</Text>
                <TouchableOpacity
                  onPress={() => setIsImportModalVisible(false)}
                  disabled={isRestoring}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="Close">
                  <Ionicons name="close" size={22} color={PipelineColors.textSecondary} />
                </TouchableOpacity>
              </View>

              <Text style={styles.modalSectionLabel}>Paste Backup JSON</Text>
              <TextInput
                style={styles.importTextArea}
                value={importText}
                onChangeText={setImportText}
                placeholder="Paste the JSON copied from Export Backup..."
                placeholderTextColor={PipelineColors.textSecondary}
                multiline
                textAlignVertical="top"
                editable={!isRestoring}
              />

              <View style={styles.addRow}>
                <TouchableOpacity
                  style={[
                    styles.addButton,
                    (isRestoring || !importText.trim()) && styles.addButtonDisabled,
                  ]}
                  onPress={handleRestoreBackup}
                  disabled={isRestoring || !importText.trim()}>
                  {isRestoring ? (
                    <ActivityIndicator size="small" color={PipelineColors.textPrimary} />
                  ) : (
                    <Text style={styles.addButtonText}>Restore</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      <Modal
        visible={isIntelModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIsIntelModalVisible(false)}>
        {/* Plain View, not Pressable: tap-to-dismiss on the backdrop was
            causing accidental closes while the user scrolled the news
            results. The modal now only closes via the explicit button. */}
        <View style={styles.addModalBackdrop}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.addModalKeyboardAvoider}>
            <Animated.View
              style={[
                styles.intelModalSheet,
                { height: intelSheetHeight, paddingBottom: 40 + insets.bottom },
              ]}>
              <View style={styles.intelDragHandleArea} {...intelSheetPanResponder.panHandlers}>
                <View style={styles.intelDragHandle} />
              </View>

              <TouchableOpacity
                style={styles.intelCloseButton}
                onPress={() => setIsIntelModalVisible(false)}
                disabled={isFetchingIntel}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel="Close">
                <Ionicons name="close" size={22} color={PipelineColors.textSecondary} />
              </TouchableOpacity>

              <Text style={[styles.addModalTitle, styles.intelModalTitle]}>On-Demand Intel</Text>

              <Text style={styles.modalSectionLabel}>Tickers (comma-separated)</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.intelTextInput}
                  value={intelInput}
                  onChangeText={setIntelInput}
                  placeholder="e.g. PLD, UNH, AMT"
                  placeholderTextColor={PipelineColors.textSecondary}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleFetchIntel}
                  editable={!isFetchingIntel}
                />
                <TouchableOpacity
                  style={[styles.addButton, isFetchingIntel && styles.addButtonDisabled]}
                  onPress={handleFetchIntel}
                  disabled={isFetchingIntel}>
                  {isFetchingIntel ? (
                    <ActivityIndicator size="small" color={PipelineColors.textPrimary} />
                  ) : (
                    <Text style={styles.addButtonText}>Fetch Intel</Text>
                  )}
                </TouchableOpacity>
              </View>

              {intelResult && (
                <ScrollView
                  style={styles.intelResultsScroll}
                  nestedScrollEnabled={true}
                  showsVerticalScrollIndicator={true}
                  persistentScrollbar={true}
                  keyboardShouldPersistTaps="handled">
                  {intelResult.results.map((entry) => (
                    <View key={entry.ticker}>
                      <Text style={styles.intelTickerSectionHeader}>=== {entry.ticker} ===</Text>

                      {entry.error ? (
                        <Text style={styles.intelErrorText}>Error: {entry.error}</Text>
                      ) : entry.news.length === 0 ? (
                        <Text style={styles.intelEmptyText}>No news found for {entry.ticker}.</Text>
                      ) : (
                        entry.news.map((article, index) => (
                          <View key={`${entry.ticker}-${index}`} style={styles.intelArticleCard}>
                            <View style={styles.intelArticleHeaderRow}>
                              <Text style={styles.intelArticlePublisher}>{article.publisher}</Text>
                              <Text style={styles.intelArticleTimestamp}>{article.publishedAt}</Text>
                            </View>
                            <Text style={styles.intelArticleTitle}>
                              {article.isCritical && (
                                <Text style={styles.intelCriticalInlineTag}>
                                  {(article.tag || '[CRITICAL ALERT]') + '  '}
                                </Text>
                              )}
                              {article.title}
                            </Text>
                            {article.link ? (
                              <TouchableOpacity
                                onPress={() => handleOpenArticleLink(article.link)}
                                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                                <Text style={styles.intelLinkButtonText}>Read Full Article →</Text>
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        ))
                      )}
                    </View>
                  ))}
                </ScrollView>
              )}

              {intelResult && intelResult.results.length > 0 && (
                <View style={styles.addRow}>
                  <TouchableOpacity style={styles.addButton} onPress={handleCopyIntel}>
                    <Text style={styles.addButtonText}>Copy Intel</Text>
                  </TouchableOpacity>
                </View>
              )}
            </Animated.View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

type PortfolioStockRowProps = {
  stock: PortfolioStock;
  accentColor: string;
  onDelete: (ticker: string) => void;
  onSaveEdit: (ticker: string, units: number, assetType: AssetType) => void;
};

// Wrapped in memo() so updating one position (price refresh, edit, delete)
// doesn't re-render every other row in the SectionList — stocks state
// updates already keep unaffected PortfolioStock objects referentially
// stable (see onRefresh/handleSaveEdit/handleDeleteTicker above), and
// accentColor/onDelete/onSaveEdit are all stable across renders too (a
// PipelineColors constant and useCallback-wrapped handlers respectively),
// so this comparison is meaningful, not a no-op.
const PortfolioStockRow = memo(function PortfolioStockRow({
  stock,
  accentColor,
  onDelete,
  onSaveEdit,
}: PortfolioStockRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [unitsText, setUnitsText] = useState(String(stock.units));
  const [editedAssetType, setEditedAssetType] = useState<AssetType>(stock.assetType);

  const totalValue = stock.units * stock.price;
  // Trailing stops are a Satellite-only mechanic: Core positions are meant
  // to be held through drawdowns, and Quality positions are risk-reviewed
  // manually (see the drawdown-review styling below) rather than
  // auto-stopped. A Core/Quality position (which could still have a tracked
  // highestWatermark from before this rule, or from being reassigned away
  // from Satellite) must show no TS field at all.
  //
  // Within Satellite, the percentage is bifurcated by asset type: ETFs are
  // structurally less volatile than individual Stocks, so they get a
  // tighter trailing stop (7% vs. 12% — see thresholds.ts).
  const trailingStopPct = stock.category === 'Satellite' ? getSatelliteTrailingStopPct(stock.assetType) : null;
  const trailingStopPrice =
    trailingStopPct !== null && stock.highestWatermark !== null
      ? stock.highestWatermark * (1 - trailingStopPct)
      : null;
  const isTrailingStopTriggered = trailingStopPrice !== null && stock.price <= trailingStopPrice;

  // Quality-layer review flag: a Quality position that has fallen 15%+
  // from its 52-week high is flagged for manual review (Quality positions
  // don't get an automatic trailing stop, so this is the equivalent
  // "pay attention" signal for that layer instead).
  const isQualityDrawdownReview =
    stock.category === 'Quality' && stock.drawdownPct !== null && stock.drawdownPct <= -15;

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

      {!isEditing && stock.high52 !== null && stock.drawdownPct !== null && (
        <View style={styles.drawdownRow}>
          <Text
            style={[styles.drawdownText, isQualityDrawdownReview && styles.drawdownTextReview]}>
            52W High: ${stock.high52.toFixed(2)} (DD: {stock.drawdownPct.toFixed(2)}%)
          </Text>
          {isQualityDrawdownReview && (
            <Text style={styles.drawdownReviewTag}>[REVIEW]</Text>
          )}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: PipelineColors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: {
    color: PipelineColors.textPrimary,
    fontSize: 28,
    fontWeight: '700',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 8,
    zIndex: 10,
  },
  unitsInput: {
    width: 70,
    backgroundColor: PipelineColors.background,
    color: PipelineColors.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    textAlign: 'center',
  },
  modalSectionLabel: {
    color: PipelineColors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  importTextArea: {
    backgroundColor: PipelineColors.background,
    color: PipelineColors.textPrimary,
    borderRadius: 8,
    padding: 12,
    fontSize: 13,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    height: 160,
    marginBottom: 20,
  },
  intelTextInput: {
    flex: 1,
    backgroundColor: PipelineColors.background,
    color: PipelineColors.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  intelResultsScroll: {
    flex: 1,
    backgroundColor: PipelineColors.background,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  intelTickerSectionHeader: {
    color: PipelineColors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  intelArticleCard: {
    backgroundColor: PipelineColors.cardBackground,
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
  },
  intelArticleHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  intelArticlePublisher: {
    color: PipelineColors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  intelArticleTimestamp: {
    color: PipelineColors.textSecondary,
    fontSize: 11,
  },
  intelArticleTitle: {
    color: PipelineColors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  intelCriticalInlineTag: {
    color: PipelineColors.bearish,
    fontWeight: '700',
  },
  intelLinkButtonText: {
    color: PipelineColors.core,
    fontSize: 13,
    fontWeight: '600',
  },
  intelErrorText: {
    color: PipelineColors.warning,
    fontSize: 13,
    marginBottom: 12,
  },
  intelEmptyText: {
    color: PipelineColors.textSecondary,
    fontSize: 13,
    marginBottom: 12,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
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
    marginBottom: 20,
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
    marginBottom: 4,
  },
  addButton: {
    backgroundColor: PipelineColors.bullish,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
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
  listWrapper: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  // SectionList renders headers/items/footers as flat siblings (not nested
  // inside a per-category wrapper the way the old ScrollView.map version
  // was), so the section title and each stock card now carry their own
  // spacing/background instead of inheriting it from a parent "section"
  // container.
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 10,
  },
  sectionEmptyText: {
    color: PipelineColors.textSecondary,
    fontSize: 14,
    marginBottom: 4,
  },
  stockCard: {
    backgroundColor: PipelineColors.cardBackground,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 10,
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
  drawdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  drawdownText: {
    color: PipelineColors.textSecondary,
    fontSize: 12,
  },
  drawdownTextReview: {
    color: PipelineColors.reviewAlert,
    fontWeight: '700',
  },
  drawdownReviewTag: {
    color: PipelineColors.reviewAlert,
    fontSize: 12,
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
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: PipelineColors.bullish,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 8,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  menuCard: {
    position: 'absolute',
    top: 64,
    right: 16,
    minWidth: 200,
    backgroundColor: PipelineColors.cardBackground,
    borderRadius: 12,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
  menuItem: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  menuItemText: {
    color: PipelineColors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: PipelineColors.background,
    marginHorizontal: 12,
  },
  addModalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  addModalKeyboardAvoider: {
    width: '100%',
  },
  addModalSheet: {
    backgroundColor: PipelineColors.cardBackground,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
  },
  addModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  addModalTitle: {
    color: PipelineColors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  // Add Asset modal only (not shared with addModalSheet, used by Import
  // Backup): bounded by maxHeight rather than auto-sized, so the
  // addAssetModalScroll child below can use flex: 1 to actually fill —
  // and scroll within — the remaining space once the keyboard eats into
  // the available screen height, instead of just growing off-screen.
  addAssetModalSheet: {
    backgroundColor: PipelineColors.cardBackground,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    maxHeight: '90%',
  },
  addAssetModalScroll: {
    flex: 1,
  },
  addAssetModalScrollContent: {
    paddingBottom: 32,
  },
  // Explicit (not auto-sized) height, driven by intelSheetHeight — that's
  // what lets the intelResultsScroll child below use flex: 1 to fill
  // remaining space instead of collapsing to its content size, and what
  // PanResponder animates between INTEL_SHEET_MIN/DEFAULT/MAX_HEIGHT as the
  // user drags the handle. paddingBottom is set inline per-instance (40 +
  // safe-area inset) so "Copy Intel" clears the OS nav bar on Android.
  intelModalSheet: {
    backgroundColor: PipelineColors.cardBackground,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 28,
    overflow: 'hidden',
  },
  // Absolutely positioned, narrower than the full sheet width, so its
  // touchable region doesn't swallow taps meant for intelCloseButton in the
  // top-right corner.
  intelDragHandleArea: {
    position: 'absolute',
    top: 0,
    left: 60,
    right: 60,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  intelDragHandle: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: PipelineColors.textSecondary,
  },
  intelModalTitle: {
    marginBottom: 20,
    paddingRight: 36,
  },
  intelCloseButton: {
    position: 'absolute',
    top: 16,
    right: 16,
    zIndex: 10,
    padding: 4,
  },
});
