import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  AT_PRICE_LABEL,
  ASSET_TYPE_LABEL_HE,
  CATEGORY_LABEL_HE,
  CATEGORY_TARGET_PCT,
  formatUnitsLabel,
} from '@/constants/labels';
import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { PORTFOLIO_TICKERS_STORAGE_KEY } from '@/constants/storage-keys';
import { SATELLITE_ETF_TS_PCT, SATELLITE_STOCK_TS_PCT } from '@/constants/thresholds';
import { usePipelineLanguage, type Language } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import {
  fetchInChunks,
  fetchIntel,
  fetchStockData,
  type IntelBatchResponse,
  type StockQuote,
} from '@/services/api';
import type { AssetType } from '@/types/asset';
import type { PortfolioCategory, PortfolioStock, PortfolioTickerEntry } from '@/types/portfolio';
import { loadAmbushTickerEntries } from '@/utils/ambush-storage';
import { createBackupPayload, parseBackupPayload, restoreBackupPayload, type BackupPayload } from '@/utils/backup';
import { deriveLocalValue, formatTotalValue, formatUnitPrice } from '@/utils/currency';
import { formatAmbushLines, formatPortfolioLines } from '@/utils/report-formatters';
import { normalizeTickerInput } from '@/utils/ticker';

type FilterOption = 'All' | PortfolioCategory;
const FILTER_OPTIONS: FilterOption[] = ['All', 'Core', 'Satellite', 'Quality'];
// Display-only Hebrew labels for the filter chips — FilterOption itself
// (and the comparisons against activeFilter) stay in English.
const FILTER_LABEL_HE: Record<FilterOption, string> = { All: 'הכל', ...CATEGORY_LABEL_HE };

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

// The return type of createStyles (defined at the bottom of this file) —
// aliased here so it can be used in prop types above that definition.
type PortfolioStyles = ReturnType<typeof createStyles>;

// Module-level (not defined inside the component) since it has no closure
// dependencies at all — not even styles/colors — a stable identity across
// renders, same reasoning as the useCallback-wrapped handlers below.
// renderPortfolioSectionHeader/Footer, by contrast, need the live
// (theme-dependent) `styles`, so they're defined inside PortfolioScreen via
// useCallback instead of living here at module level.
function extractPortfolioItemKey(item: PortfolioStock): string {
  return item.ticker;
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

// ALLOCATION STATUS: builds the "<layer> (יעד: X% | מצוי: Y%) - N נכסים"
// section-header string — target (יעד) from the fixed Fortress 2.0 Model
// (CATEGORY_TARGET_PCT), actual (מצוי) computed live from this layer's
// share of the whole portfolio's value, and N the number of tickers in it.
//
// Both categoryStocks' contribution and totalPortfolioValue MUST be
// computed from `stock.price` (USD-normalized by the backend's
// Multi-Currency engine) — never `stock.localPrice`. Summing a Shekel
// value and a Dollar value directly would silently corrupt every
// percentage this produces; that's the exact "mathematical flaw" the
// Multi-Currency engine exists to fix.
function buildSectionTitle(
  category: PortfolioCategory,
  categoryStocks: PortfolioStock[],
  totalPortfolioValue: number,
): string {
  const categoryValue = categoryStocks.reduce((sum, stock) => sum + stock.units * stock.price, 0);
  const actualPct = totalPortfolioValue > 0 ? (categoryValue / totalPortfolioValue) * 100 : 0;
  return (
    `${CATEGORY_LABEL_HE[category]} (יעד: ${CATEGORY_TARGET_PCT[category]}% | ` +
    `מצוי: ${actualPct.toFixed(1)}%) - ${categoryStocks.length} נכסים`
  );
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
  const [isLanguageMenuVisible, setIsLanguageMenuVisible] = useState(false);
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

  const { colors, isDarkMode, toggleTheme } = usePipelineTheme();
  // DYNAMIC LANGUAGE TOGGLE: a plain context read, same as usePipelineTheme
  // above — switching languages re-renders this screen (and every child
  // that reads it, directly or via props) immediately, no app restart.
  const { language, setLanguage } = usePipelineLanguage();
  // Re-derived only when the active theme actually changes (StyleSheet.create
  // bakes in whatever colors it's given at call time, so this can't be a
  // module-level constant the way it used to be — see createStyles below).
  const styles = useMemo(() => createStyles(colors, isDarkMode, language), [colors, isDarkMode, language]);

  const insets = useSafeAreaInsets();

  // Moved inside the component (were module-level functions before the
  // theme toggle existed) since they now need the live, theme-dependent
  // `styles` in their closure. Stable via useCallback, re-created only when
  // styles itself changes — same referential-stability reasoning as
  // renderPortfolioRow below.
  const renderPortfolioSectionHeader = useCallback(
    ({ section }: { section: PortfolioListSection }) => (
      <Text style={[styles.sectionTitle, { color: section.accentColor }]}>{section.title}</Text>
    ),
    [styles],
  );

  const renderPortfolioSectionFooter = useCallback(
    ({ section }: { section: PortfolioListSection }) =>
      section.data.length === 0 ? <Text style={styles.sectionEmptyText}>אין עדיין פוזיציות.</Text> : null,
    [styles],
  );

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

      // CONCURRENCY LIMITING: fetched in small batches (not one giant
      // Promise.allSettled over the whole portfolio at once) to avoid
      // overwhelming the network with N simultaneous connections — this
      // still awaits the full queue before moving on, so isInitializing
      // below only flips to false once every batch has resolved.
      const results = await fetchInChunks(entries, (entry) => fetchStockData(entry.ticker));

      const loadedStocks: PortfolioStock[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const entry = entries[index];
          loadedStocks.push({
            ...entry,
            price: result.value.price,
            localPrice: result.value.localPrice,
            currencySymbol: result.value.currencySymbol,
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
      Alert.alert('יחידות לא תקינות', 'נא להזין מספר יחידות חיובי.');
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
          localPrice: quote.localPrice,
          currencySymbol: quote.currencySymbol,
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
        error instanceof Error ? error.message : `שליפת הנתונים עבור ${normalizedTicker} נכשלה.`;
      Alert.alert('לא ניתן להוסיף טיקר', message);
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
        colors={colors}
        styles={styles}
        language={language}
      />
    ),
    [handleDeleteTicker, handleSaveEdit, colors, styles, language],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const tickersToRefresh = stocks.map((stock) => stock.ticker);
      // CONCURRENCY LIMITING: see loadInitialStocks above — small batches,
      // not one Promise.allSettled over the whole list.
      const results = await fetchInChunks(tickersToRefresh, (t) => fetchStockData(t));

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
            localPrice: freshQuote.localPrice,
            currencySymbol: freshQuote.currencySymbol,
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
      Alert.alert('הועתק', 'נתוני התיק הועתקו ללוח.');
    } catch {
      Alert.alert('ההעתקה נכשלה', 'לא ניתן היה להעתיק את נתוני התיק ללוח.');
    }
  };

  const handleCopyAllData = async () => {
    setIsExportingAll(true);
    try {
      const ambushEntries = (await loadAmbushTickerEntries()) ?? [];

      // CONCURRENCY LIMITING: see loadInitialStocks above.
      const ambushResults = await fetchInChunks(ambushEntries, (entry) => fetchStockData(entry.ticker));

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
      Alert.alert('הועתק', 'נתוני התיק והמארב הועתקו יחד ללוח.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'יצירת ייצוא הנתונים המשולב נכשלה.';
      Alert.alert('ההעתקה נכשלה', message);
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
        'הגיבוי יוצא',
        'נתוני התיק והמארב הועתקו ללוח כ-JSON. הדבק אותם במקום בטוח.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ייצוא הגיבוי נכשל.';
      Alert.alert('הייצוא נכשל', message);
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
      const message = error instanceof Error ? error.message : 'הטקסט שהודבק אינו גיבוי תקין.';
      Alert.alert('גיבוי לא תקין', message);
      return;
    }

    setIsRestoring(true);
    try {
      await restoreBackupPayload(payload);

      // Update this screen's own live state immediately (mirrors the
      // initial-load flow); Ambush Radar's separate mounted screen picks up
      // its half of the restore the next time its tab gains focus.
      // CONCURRENCY LIMITING: see loadInitialStocks above.
      const results = await fetchInChunks(payload.portfolio, (entry) => fetchStockData(entry.ticker));

      const hydratedStocks: PortfolioStock[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const entry = payload.portfolio[index];
          hydratedStocks.push({
            ...entry,
            price: result.value.price,
            localPrice: result.value.localPrice,
            currencySymbol: result.value.currencySymbol,
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
          'הגיבוי שוחזר',
          'הנתונים נשמרו, אך לא ניתן היה לטעון מחירים חיים כרגע. משוך לרענון בעוד רגע.',
        );
        return;
      }

      setStocks(hydratedStocks);
      Alert.alert('הגיבוי שוחזר', 'נתוני התיק והמארב שוחזרו.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'שחזור הגיבוי נכשל.';
      Alert.alert('השחזור נכשל', message);
    } finally {
      setIsRestoring(false);
    }
  };

  const handleFetchIntel = async () => {
    if (!intelInput.trim()) {
      Alert.alert('נדרש טיקר', 'נא להזין לפחות סימול טיקר אחד.');
      return;
    }

    setIsFetchingIntel(true);
    setIntelResult(null);
    try {
      const result = await fetchIntel(intelInput);
      setIntelResult(result);

      const hasAnyNews = result.results.some((entry) => entry.news.length > 0);
      if (!hasAnyNews) {
        Alert.alert('לא נמצאו חדשות', 'לא נמצאו חדשות אחרונות עבור הטיקרים המבוקשים.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'שליפת המודיעין נכשלה.';
      Alert.alert('שליפת המודיעין נכשלה', message);
    } finally {
      setIsFetchingIntel(false);
    }
  };

  const handleOpenArticleLink = (url: string) => {
    Linking.openURL(url).catch(() => {
      Alert.alert('לא ניתן לפתוח את הקישור', 'לא ניתן היה לפתוח את קישור הכתבה.');
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
      Alert.alert('הועתק', 'כותרות המודיעין הועתקו ללוח.');
    } catch {
      Alert.alert('ההעתקה נכשלה', 'לא ניתן היה להעתיק את המודיעין ללוח.');
    }
  };

  // ALLOCATION STATUS: both the per-layer contribution and this grand
  // total are `units * price` (USD) — never `localPrice` — so a Shekel
  // TASE position and a Dollar US position sum together correctly. See
  // buildSectionTitle above for how this feeds the section headers.
  const coreStocks = stocks.filter((stock) => stock.category === 'Core');
  const satelliteStocks = stocks.filter((stock) => stock.category === 'Satellite');
  const qualityStocks = stocks.filter((stock) => stock.category === 'Quality');
  const totalPortfolioValue = stocks.reduce((sum, stock) => sum + stock.units * stock.price, 0);

  const allSections: PortfolioListSection[] = [
    {
      title: buildSectionTitle('Core', coreStocks, totalPortfolioValue),
      category: 'Core',
      accentColor: colors.core,
      data: coreStocks,
    },
    {
      title: buildSectionTitle('Satellite', satelliteStocks, totalPortfolioValue),
      category: 'Satellite',
      accentColor: colors.satellite,
      data: satelliteStocks,
    },
    {
      title: buildSectionTitle('Quality', qualityStocks, totalPortfolioValue),
      category: 'Quality',
      accentColor: colors.quality,
      data: qualityStocks,
    },
  ];
  const visibleSections = allSections.filter(
    (section) => activeFilter === 'All' || activeFilter === section.category,
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <StatusBar style={isDarkMode ? 'light' : 'dark'} />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>תיק השקעות</Text>
        <View style={styles.headerActions}>
          {/* Standalone theme toggle, separate from the "More options"
              dropdown — a single-tap action belongs in the header itself,
              not buried in a menu. Icon reflects the CURRENT theme (sun
              while light, moon while dark); tapping switches to the other. */}
          <TouchableOpacity
            onPress={toggleTheme}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={isDarkMode ? 'עבור למצב בהיר' : 'עבור למצב כהה'}>
            <Ionicons name={isDarkMode ? 'moon' : 'sunny'} size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          {/* DYNAMIC LANGUAGE TOGGLE: opens a small dropdown to pick English
              or עברית — the language itself lives in LanguageContext, shared
              app-wide, so this takes effect on both tabs immediately, with
              no navigation/refocus or app restart needed (unlike RN's own
              I18nManager RTL flip, which requires a reload). */}
          <TouchableOpacity
            onPress={() => setIsLanguageMenuVisible(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={language === 'he' ? 'שנה שפה' : 'Change language'}>
            <Ionicons name="globe-outline" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setIsMenuVisible(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="אפשרויות נוספות">
            <Ionicons name="ellipsis-horizontal" size={24} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>
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
              {FILTER_LABEL_HE[filterOption]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {isInitializing ? (
        <View style={styles.initializingContainer}>
          <PullToRefreshLogo isRefreshing overlay={false} />
          <Text style={styles.initializingText}>טוען את התיק שלך...</Text>
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
                // Android's native SwipeRefreshLayout circle carries its own
                // baked-in drop shadow/elevation that colors={['transparent']}
                // + progressBackgroundColor="transparent" can't fully hide —
                // it still shows as a faint smudge in Light Mode. -500 pushes
                // it completely off the top of the screen; refreshing/
                // onRefresh stay wired normally so the pull gesture itself
                // still works exactly as before — only the native visual is
                // banished, leaving PullToRefreshLogo as the sole indicator.
                progressViewOffset={-500}
              />
            }
          />
        </View>
      )}

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setIsAddModalVisible(true)}
        accessibilityLabel="הוסף נכס לתיק">
        <Ionicons name="add" size={28} color={colors.textPrimary} />
      </TouchableOpacity>

      <Modal
        visible={isMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIsMenuVisible(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setIsMenuVisible(false)}>
          <View style={styles.menuCard}>
            {/* Group 1: data export actions that read the current on-screen
                state directly (no extra modal). */}
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setIsMenuVisible(false);
                handleCopyPortfolioData();
              }}>
              <Text style={styles.menuItemText}>העתק נתוני תיק</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuItem}
              disabled={isExportingAll}
              onPress={() => {
                setIsMenuVisible(false);
                handleCopyAllData();
              }}>
              {isExportingAll ? (
                <ActivityIndicator size="small" color={colors.textPrimary} />
              ) : (
                <Text style={styles.menuItemText}>העתק את כל הנתונים</Text>
              )}
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            {/* Group 2: JSON backup import/export. */}
            <TouchableOpacity
              style={styles.menuItem}
              disabled={isExportingBackup}
              onPress={() => {
                setIsMenuVisible(false);
                handleExportBackup();
              }}>
              {isExportingBackup ? (
                <ActivityIndicator size="small" color={colors.textPrimary} />
              ) : (
                <Text style={styles.menuItemText}>ייצוא גיבוי (JSON)</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setIsMenuVisible(false);
                setIsImportModalVisible(true);
              }}>
              <Text style={styles.menuItemText}>ייבוא גיבוי (JSON)</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            {/* Group 3: On-Demand Intel. Theme toggle used to live here as a
                trailing text item — it's now a standalone icon button in the
                header itself (see headerActions above), a single-tap
                action doesn't belong buried in a dropdown. */}
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setIsMenuVisible(false);
                setIsIntelModalVisible(true);
              }}>
              <Text style={styles.menuItemText}>מודיעין לפי דרישה</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* DYNAMIC LANGUAGE TOGGLE dropdown: a small ActionSheet-style card
          (same Modal + Pressable-backdrop pattern as the "More options" menu
          above), offering the two supported languages. Selecting one calls
          LanguageContext's setLanguage directly, which persists it and
          triggers an ordinary re-render everywhere it's read — no app
          restart. */}
      <Modal
        visible={isLanguageMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIsLanguageMenuVisible(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setIsLanguageMenuVisible(false)}>
          <View style={styles.languageMenuCard}>
            <TouchableOpacity
              style={styles.languageMenuItem}
              onPress={() => {
                setLanguage('en');
                setIsLanguageMenuVisible(false);
              }}>
              <Text style={styles.menuItemText}>English</Text>
              {language === 'en' && <Ionicons name="checkmark" size={18} color={colors.bullish} />}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.languageMenuItem}
              onPress={() => {
                setLanguage('he');
                setIsLanguageMenuVisible(false);
              }}>
              <Text style={styles.menuItemText}>עברית</Text>
              {language === 'he' && <Ionicons name="checkmark" size={18} color={colors.bullish} />}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      <Modal
        visible={isAddModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIsAddModalVisible(false)}>
        {/* Root cause of the "squashed sliver" bug this replaces: the old
            bottom-sheet layout gave the KeyboardAvoidingView no flex/height
            of its own (just width: '100%', sized to content, anchored via
            the backdrop's justifyContent: 'flex-end') while also using
            behavior="height" on Android — with no intrinsic height to
            shrink FROM, that behavior could resolve to a near-zero height
            once the keyboard opened. Centering the card instead (flex: 1
            on both the backdrop and the KeyboardAvoidingView, the latter
            with justifyContent/alignItems: 'center') gives both a real,
            unambiguous size at every step, keyboard open or not.

            A second, subtler version of the same bug survived that first
            fix: addAssetModalCard still had a percentage maxHeight, and its
            ScrollView still had flex: 1 — Android Modals don't inherit a
            keyboard-triggered window resize the way a normal screen does,
            so that flex/percentage combo could still resolve to ~0 height
            during the resize pass. addAssetModalCard/addAssetModalScroll
            below are now deliberately INTRINSIC height (no flex: 1, no
            maxHeight) instead, so the card just sizes to its own content
            every time. */}
        <Pressable style={styles.addAssetModalBackdrop} onPress={() => setIsAddModalVisible(false)}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.addAssetModalAvoider}>
            {/* TouchableWithoutFeedback so tapping any non-interactive part
                of the card (not just the backdrop outside it) dismisses
                the keyboard without closing the whole modal — nested
                TouchableOpacity/TextInput children still get their own taps
                as normal, RN's responder system gives them priority. */}
            <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
              <View style={styles.addAssetModalCard}>
                <View style={styles.addModalHeader}>
                  <Text style={styles.addModalTitle}>הוסף נכס</Text>
                  <TouchableOpacity
                    onPress={() => setIsAddModalVisible(false)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityLabel="סגור">
                    <Ionicons name="close" size={22} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>

                {/* Intrinsic height (no flex: 1 — see addAssetModalScroll's
                    definition below for why), so this form just sizes to
                    its own content instead of stretching/collapsing against
                    a bounded parent. keyboardShouldPersistTaps keeps the
                    category/asset-type/add buttons tappable while the
                    keyboard is still up. */}
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
                      placeholder="יחידות"
                      placeholderTextColor={colors.textSecondary}
                      keyboardType="numeric"
                      editable={!isAdding}
                    />
                  </View>

                  <Text style={styles.modalSectionLabel}>קטגוריה</Text>
                  <View style={styles.categoryRow}>
                    <TouchableOpacity
                      style={[
                        styles.categoryButton,
                        { borderColor: colors.core },
                        selectedCategory === 'Core' && { backgroundColor: colors.core },
                      ]}
                      onPress={() => setSelectedCategory('Core')}>
                      <Text style={styles.categoryButtonText}>{CATEGORY_LABEL_HE.Core}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.categoryButton,
                        { borderColor: colors.satellite },
                        selectedCategory === 'Satellite' && { backgroundColor: colors.satellite },
                      ]}
                      onPress={() => setSelectedCategory('Satellite')}>
                      <Text style={styles.categoryButtonText}>{CATEGORY_LABEL_HE.Satellite}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.categoryButton,
                        { borderColor: colors.quality },
                        selectedCategory === 'Quality' && { backgroundColor: colors.quality },
                      ]}
                      onPress={() => setSelectedCategory('Quality')}>
                      <Text style={styles.categoryButtonText}>{CATEGORY_LABEL_HE.Quality}</Text>
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.modalSectionLabel}>סוג נכס</Text>
                  <View style={styles.assetTypeRow}>
                    <TouchableOpacity
                      style={[
                        styles.assetTypeButton,
                        { borderColor: colors.bullish },
                        selectedAssetType === 'Stock' && { backgroundColor: colors.bullish },
                      ]}
                      onPress={() => setSelectedAssetType('Stock')}>
                      <Text style={styles.assetTypeButtonText}>{ASSET_TYPE_LABEL_HE.Stock}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.assetTypeButton,
                        { borderColor: colors.core },
                        selectedAssetType === 'ETF' && { backgroundColor: colors.core },
                      ]}
                      onPress={() => setSelectedAssetType('ETF')}>
                      <Text style={styles.assetTypeButtonText}>{ASSET_TYPE_LABEL_HE.ETF}</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.addRow}>
                    <TouchableOpacity
                      style={[styles.addButton, isAdding && styles.addButtonDisabled]}
                      onPress={handleAddTicker}
                      disabled={isAdding}>
                      {isAdding ? (
                        <ActivityIndicator size="small" color={colors.textPrimary} />
                      ) : (
                        <Text style={styles.addButtonText}>הוסף לתיק</Text>
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
                <Text style={styles.addModalTitle}>ייבוא גיבוי</Text>
                <TouchableOpacity
                  onPress={() => setIsImportModalVisible(false)}
                  disabled={isRestoring}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="סגור">
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>

              <Text style={styles.modalSectionLabel}>הדבק JSON של גיבוי</Text>
              <TextInput
                style={styles.importTextArea}
                value={importText}
                onChangeText={setImportText}
                placeholder="הדבק כאן את ה-JSON שהועתק מייצוא הגיבוי..."
                placeholderTextColor={colors.textSecondary}
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
                    <ActivityIndicator size="small" color={colors.textPrimary} />
                  ) : (
                    <Text style={styles.addButtonText}>שחזר</Text>
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
                accessibilityLabel="סגור">
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>

              <Text style={[styles.addModalTitle, styles.intelModalTitle]}>מודיעין לפי דרישה</Text>

              <Text style={styles.modalSectionLabel}>טיקרים (מופרדים בפסיקים)</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.intelTextInput}
                  value={intelInput}
                  onChangeText={setIntelInput}
                  placeholder="לדוגמה: PLD, UNH, AMT"
                  placeholderTextColor={colors.textSecondary}
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
                    <ActivityIndicator size="small" color={colors.textPrimary} />
                  ) : (
                    <Text style={styles.addButtonText}>שלוף מודיעין</Text>
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
                        <Text style={styles.intelErrorText}>שגיאה: {entry.error}</Text>
                      ) : entry.news.length === 0 ? (
                        <Text style={styles.intelEmptyText}>לא נמצאו חדשות עבור {entry.ticker}.</Text>
                      ) : (
                        // Article title/publisher/timestamp are Yahoo's own
                        // news content (in whatever language the source
                        // publishes in) — not app UI chrome, so left
                        // untranslated/at default (LTR) alignment.
                        entry.news.map((article, index) => (
                          <View key={`${entry.ticker}-${index}`} style={styles.intelArticleCard}>
                            <View style={styles.intelArticleHeaderRow}>
                              <Text style={styles.intelArticlePublisher}>{article.publisher}</Text>
                              <Text style={styles.intelArticleTimestamp}>{article.publishedAt}</Text>
                            </View>
                            <Text style={styles.intelArticleTitle}>
                              {article.isCritical && (
                                <Text style={styles.intelCriticalInlineTag}>
                                  {(article.tag || '[התראה קריטית]') + '  '}
                                </Text>
                              )}
                              {article.title}
                            </Text>
                            {article.link ? (
                              <TouchableOpacity
                                onPress={() => handleOpenArticleLink(article.link)}
                                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                                <Text style={styles.intelLinkButtonText}>קרא כתבה מלאה ←</Text>
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
                    <Text style={styles.addButtonText}>העתק מודיעין</Text>
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
  colors: PipelineColorScheme;
  styles: PortfolioStyles;
  language: Language;
};

// Wrapped in memo() so updating one position (price refresh, edit, delete)
// doesn't re-render every other row in the SectionList — stocks state
// updates already keep unaffected PortfolioStock objects referentially
// stable (see onRefresh/handleSaveEdit/handleDeleteTicker above), and
// accentColor/onDelete/onSaveEdit/colors/styles/language are all stable
// across renders too (a fixed per-theme accent color, useCallback-wrapped
// handlers, the parent's own useMemo-derived theme values, and the
// language string itself respectively — colors/styles only actually change
// reference on a real theme toggle, language only on a real language
// switch), so
// this comparison is meaningful, not a no-op. memo() only shallow-compares
// props, not context, but this component reads no context of its own —
// colors/styles/language arrive as props from PortfolioScreen, which is
// what actually re-renders on a theme or language change and passes the
// new values down.
const PortfolioStockRow = memo(function PortfolioStockRow({
  stock,
  accentColor,
  onDelete,
  onSaveEdit,
  colors,
  styles,
  language,
}: PortfolioStockRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [unitsText, setUnitsText] = useState(String(stock.units));
  const [editedAssetType, setEditedAssetType] = useState<AssetType>(stock.assetType);

  // MULTI-CURRENCY DISPLAY: this row's own total, shown in the
  // instrument's own local currency (self-consistent — it's all one
  // instrument, so there's no cross-currency mixing risk here). This is
  // NEVER used for portfolio-wide totals/allocation math — that's computed
  // independently in PortfolioScreen from `stock.price` (USD) alone; see
  // the IMPORTANT note above allSections there.
  const localTotalValue = stock.units * stock.localPrice;

  // TASE AGOROT DISPLAY: the UNIT price, Agorot-formatted for a ".TA"
  // ticker (e.g. "3985 אג'") — the position TOTAL above/below always stays
  // in whole Shekels regardless (see formatTotalValue), matching how
  // Israeli banks quote unit prices vs. position values differently.
  const unitPriceDisplay = formatUnitPrice(stock.ticker, stock.localPrice, stock.currencySymbol, language);
  const totalValueDisplay = formatTotalValue(localTotalValue, stock.currencySymbol);

  // Same Agorot treatment for the 52-week high shown in the drawdown row
  // below — high52 is USD-normalized (see PortfolioStock's own field
  // comment), so it's first scaled onto localPrice's basis (exact, not an
  // approximation — see deriveLocalValue) before formatting.
  const localHigh52 = stock.high52 !== null ? deriveLocalValue(stock.high52, stock.localPrice, stock.price) : null;
  const high52Display =
    localHigh52 !== null ? formatUnitPrice(stock.ticker, localHigh52, stock.currencySymbol, language) : null;
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
      Alert.alert('יחידות לא תקינות', 'נא להזין מספר יחידות חיובי.');
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
            <Text style={styles.assetTypeBadgeText}>{ASSET_TYPE_LABEL_HE[stock.assetType]}</Text>
          </View>
          <View style={[styles.categoryBadge, { backgroundColor: accentColor }]}>
            <Text style={styles.categoryBadgeText}>{CATEGORY_LABEL_HE[stock.category]}</Text>
          </View>
          <TouchableOpacity
            onPress={() => onDelete(stock.ticker)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={`הסר את ${stock.ticker} מהתיק`}>
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
              accessibilityLabel={`שמור שינויים עבור ${stock.ticker}`}>
              <Ionicons name="checkmark" size={20} color={colors.bullish} />
            </TouchableOpacity>
          </View>
          <View style={styles.editAssetTypeRow}>
            <TouchableOpacity
              style={[
                styles.editAssetTypeButton,
                { borderColor: colors.bullish },
                editedAssetType === 'Stock' && { backgroundColor: colors.bullish },
              ]}
              onPress={() => setEditedAssetType('Stock')}>
              <Text style={styles.editAssetTypeButtonText}>{ASSET_TYPE_LABEL_HE.Stock}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.editAssetTypeButton,
                { borderColor: colors.core },
                editedAssetType === 'ETF' && { backgroundColor: colors.core },
              ]}
              onPress={() => setEditedAssetType('ETF')}>
              <Text style={styles.editAssetTypeButtonText}>{ASSET_TYPE_LABEL_HE.ETF}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.stockBottomRow}>
          <View style={styles.unitsDisplayRow}>
            {/* RTL MIXED TEXT RENDERING FIX: this used to be one interpolated
                string starting with a number ("1436 יח' ב-₪39.85"), which
                the bidi text engine renders reversed — a number-first run
                inside an RTL-aligned Text confuses it in a way a
                Hebrew-first string doesn't. Split into three independent
                <Text> nodes instead, laid out by an explicit row/row-reverse
                View so each language's natural reading order (and its own
                phrasing — see AT_PRICE_LABEL/formatUnitsLabel) determines
                the visual order directly, rather than relying on bidi to
                sort out a single mixed-content string.
                TASE AGOROT DISPLAY: unitPriceDisplay reads e.g. "3985 אג'"
                instead of "₪39.85" for a ".TA" ticker — see
                formatUnitPrice above. */}
            <View style={styles.unitsPriceRow}>
              <Text style={styles.stockDetailText}>{formatUnitsLabel(language, stock.units)}</Text>
              <Text style={styles.stockDetailText}>{AT_PRICE_LABEL[language]}</Text>
              <Text style={styles.stockDetailValueText}>{unitPriceDisplay}</Text>
            </View>
            <TouchableOpacity
              onPress={handleStartEditing}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel={`ערוך את ${stock.ticker}`}>
              <Ionicons name="pencil" size={14} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {/* TASE AGOROT DISPLAY: the TOTAL position value stays in whole
              Shekels (never Agorot) regardless of ticker — Israeli banking
              convention quotes unit prices in Agorot but totals in
              Shekels; see formatTotalValue above. */}
          <Text style={styles.stockTotalValue}>{totalValueDisplay}</Text>
        </View>
      )}

      {!isEditing && trailingStopPrice !== null && (
        // Trailing Stop is a computed USD threshold (highestWatermark is
        // tracked in USD — see computeHighestWatermark above), not a raw
        // quoted price, so it stays displayed in USD ('$') regardless of
        // the instrument's own trading currency — converting a derived
        // threshold back to local currency isn't something the frontend
        // can do without re-deriving the FX rate itself.
        <Text
          style={[
            styles.trailingStopText,
            isTrailingStopTriggered && styles.trailingStopTriggeredText,
          ]}>
          {isTrailingStopTriggered ? '⚠ ' : ''}עצירה נגררת מופעלת ב: ${trailingStopPrice.toFixed(2)}
        </Text>
      )}

      {!isEditing && high52Display !== null && stock.drawdownPct !== null && (
        // TASE AGOROT DISPLAY: high52Display reads e.g. "3985 אג'" for a
        // ".TA" ticker (derived from the USD-normalized stock.high52 via
        // deriveLocalValue above), or "$X.XX"/"₪X.XX" otherwise — see the
        // trailing-stop text below for the one price-like field that
        // deliberately stays USD regardless (a computed threshold, not a
        // raw quote).
        <View style={styles.drawdownRow}>
          <Text
            style={[styles.drawdownText, isQualityDrawdownReview && styles.drawdownTextReview]}>
            שיא 52 שבועות: {high52Display} (ירידה: {stock.drawdownPct.toFixed(2)}%)
          </Text>
          {isQualityDrawdownReview && (
            <Text style={styles.drawdownReviewTag}>[לבדיקה]</Text>
          )}
        </View>
      )}
    </View>
  );
});

// A factory (not a module-level StyleSheet.create) so it can be re-derived
// whenever the active theme OR language changes — StyleSheet.create bakes
// in whatever values it's given at the moment it's called, so a
// module-level call would freeze in whichever theme/language happened to
// be active on first import and never update. Called from a
// useMemo(() => createStyles(colors, isDarkMode, language), [colors,
// isDarkMode, language]) inside PortfolioScreen, so it only actually
// re-runs on a real theme or language change, not on every render.
function createStyles(colors: PipelineColorScheme, isDarkMode: boolean, language: Language) {
  return StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: {
    // RTL LOCALIZATION: standard Hebrew label text is right-aligned;
    // numeric values/ticker symbols elsewhere are deliberately left at
    // their default (LTR) alignment instead (see StockCard.tsx).
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
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
    backgroundColor: colors.background,
    color: colors.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    textAlign: 'center',
  },
  modalSectionLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 8,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  importTextArea: {
    backgroundColor: colors.background,
    color: colors.textPrimary,
    borderRadius: 8,
    padding: 12,
    fontSize: 13,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    height: 160,
    marginBottom: 20,
  },
  intelTextInput: {
    flex: 1,
    backgroundColor: colors.background,
    color: colors.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  intelResultsScroll: {
    flex: 1,
    backgroundColor: colors.background,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  intelTickerSectionHeader: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  intelArticleCard: {
    backgroundColor: colors.cardBackground,
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
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  intelArticleTimestamp: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  intelArticleTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  intelCriticalInlineTag: {
    color: colors.bearish,
    fontWeight: '700',
  },
  intelLinkButtonText: {
    color: colors.core,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  intelErrorText: {
    color: colors.warning,
    fontSize: 13,
    marginBottom: 12,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  intelEmptyText: {
    color: colors.textSecondary,
    fontSize: 13,
    marginBottom: 12,
    textAlign: 'right',
    writingDirection: 'rtl',
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
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    writingDirection: 'rtl',
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
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    writingDirection: 'rtl',
  },
  addRow: {
    marginBottom: 4,
  },
  addButton: {
    backgroundColor: colors.bullish,
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
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    writingDirection: 'rtl',
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
    backgroundColor: colors.cardBackground,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  filterButtonActive: {
    backgroundColor: colors.textPrimary,
  },
  filterButtonText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    writingDirection: 'rtl',
  },
  filterButtonTextActive: {
    color: colors.background,
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
    // RTL: the full "<layer> (יעד: X% | מצוי: Y%) - N נכסים" string is
    // Hebrew-first with embedded LTR numeric runs (percentages, the
    // count) — the Unicode bidi algorithm places those correctly within
    // an RTL-aligned paragraph on its own, no special handling needed.
    fontSize: 16,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 10,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  sectionEmptyText: {
    color: colors.textSecondary,
    fontSize: 14,
    marginBottom: 4,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  stockCard: {
    backgroundColor: colors.cardBackground,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 10,
    // Light theme's white cards need a subtle shadow to read as distinct/
    // elevated against the light-gray page background; dark theme's cards
    // already contrast against the near-black background without one.
    ...(isDarkMode
      ? null
      : {
          shadowColor: '#000',
          shadowOpacity: 0.08,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 2 },
          elevation: 2,
        }),
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
    // Ticker symbols stay LTR regardless of app language — they're
    // identifiers, not translatable text (per the RTL localization spec).
    flex: 1,
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  assetTypeBadge: {
    backgroundColor: colors.background,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  assetTypeBadgeText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  categoryBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  categoryBadgeText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  deleteButtonText: {
    color: colors.bearish,
    fontSize: 16,
    fontWeight: '700',
  },
  stockBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  // RTL MIXED TEXT RENDERING FIX: split into 3 independent <Text> nodes
  // (units label / at-word / price value — see unitsPriceRow below) instead
  // of one interpolated string, so a number-first run (the units count)
  // never has to share a Text node with Hebrew words for bidi to untangle.
  stockDetailText: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: language === 'he' ? 'right' : 'left',
    writingDirection: language === 'he' ? 'rtl' : 'ltr',
  },
  // The price VALUE alone (currency symbol/Agorot + number) — always LTR,
  // regardless of language, same as stockTotalValue below.
  stockDetailValueText: {
    color: colors.textSecondary,
    fontSize: 13,
    writingDirection: 'ltr',
  },
  stockTotalValue: {
    // Pure currency value (symbol + number), no Hebrew words — stays LTR.
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    writingDirection: 'ltr',
  },
  unitsDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // DYNAMIC LANGUAGE TOGGLE: row for English (units → at-word → price,
  // left to right), row-reverse for Hebrew (same JSX child order, laid out
  // right to left instead — see the <Text> nodes at their call site) so
  // the exact same three <Text> nodes read correctly in either language.
  unitsPriceRow: {
    flexDirection: language === 'he' ? 'row-reverse' : 'row',
    alignItems: 'center',
    gap: 4,
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
    backgroundColor: colors.background,
    color: colors.textPrimary,
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
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600',
    writingDirection: 'rtl',
  },
  trailingStopText: {
    // Hebrew label + LTR '$' threshold value — RTL paragraph, bidi handles
    // the embedded number.
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 6,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  trailingStopTriggeredText: {
    color: colors.warning,
    fontWeight: '700',
  },
  drawdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  drawdownText: {
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  drawdownTextReview: {
    color: colors.reviewAlert,
    fontWeight: '700',
  },
  drawdownReviewTag: {
    color: colors.reviewAlert,
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
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.bullish,
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
    backgroundColor: colors.cardBackground,
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
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.background,
    marginHorizontal: 12,
  },
  // DYNAMIC LANGUAGE TOGGLE dropdown card — same visual treatment as
  // menuCard above, just anchored further left (under the globe icon,
  // which sits to the left of the "..." menu button) and narrower, since it
  // only ever holds two short language names.
  languageMenuCard: {
    position: 'absolute',
    top: 64,
    right: 56,
    minWidth: 140,
    backgroundColor: colors.cardBackground,
    borderRadius: 12,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
  languageMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
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
    backgroundColor: colors.cardBackground,
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
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  // Add Asset modal only (not shared with addModalSheet, used by Import
  // Backup) — a centered card, not a bottom sheet: full-screen dim layer.
  addAssetModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  // flex: 1 (a real, unambiguous size to begin with) + justifyContent/
  // alignItems: 'center' is what centers addAssetModalCard and keeps it
  // that way whether or not the keyboard is open — see the root-cause note
  // above this modal's JSX.
  addAssetModalAvoider: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Deliberately an INTRINSIC height — no flex: 1, no maxHeight/height of
  // any kind. This is the actual fix for the "squashed to 0" bug: a flex/
  // percentage-bound card nested inside a KeyboardAvoidingView can resolve
  // to a zero or near-zero height on Android during the keyboard's resize
  // pass, since Android Modals don't inherit the resized window the same
  // way a normal screen does. An intrinsic-height card just sizes to its
  // own content every time, keyboard open or not, and addAssetModalAvoider
  // above (flex: 1 + justifyContent/alignItems: 'center') centers whatever
  // that size turns out to be.
  addAssetModalCard: {
    width: '90%',
    backgroundColor: colors.cardBackground,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  // No flex: 1 here either, for the same reason as addAssetModalCard above
  // — this form is short enough to always fit at its intrinsic size, so it
  // doesn't need to flex-fill or scroll-clip against a bounded parent.
  // Still a ScrollView (not a plain View) purely to keep
  // keyboardShouldPersistTaps="handled" for the category/asset-type/add
  // buttons while a text input has focus.
  addAssetModalScroll: {
    flexGrow: 0,
  },
  addAssetModalScrollContent: {
    paddingBottom: 24,
  },
  // Explicit (not auto-sized) height, driven by intelSheetHeight — that's
  // what lets the intelResultsScroll child below use flex: 1 to fill
  // remaining space instead of collapsing to its content size, and what
  // PanResponder animates between INTEL_SHEET_MIN/DEFAULT/MAX_HEIGHT as the
  // user drags the handle. paddingBottom is set inline per-instance (40 +
  // safe-area inset) so "Copy Intel" clears the OS nav bar on Android.
  intelModalSheet: {
    backgroundColor: colors.cardBackground,
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
    backgroundColor: colors.textSecondary,
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
}
