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
import { SatelliteProtectionCard } from '@/components/SatelliteProtectionCard';
import type { Stock } from '@/components/StockCard';
import { TickerAutocomplete } from '@/components/TickerAutocomplete';
import { assetTypeLabel, categoryLabel, CATEGORY_TARGET_PCT, formatUnitsLabel } from '@/constants/labels';
import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { PORTFOLIO_TICKERS_STORAGE_KEY } from '@/constants/storage-keys';
import { SATELLITE_TS_PCT } from '@/constants/thresholds';
import { usePipelineLanguage, type Language, type TFunction } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import { useAppForegroundRefresh } from '@/hooks/useAppForegroundRefresh';
import {
  createUnavailableQuote,
  fetchInChunks,
  fetchIntel,
  fetchStockData,
  liquidatePortfolioAsset,
  type IntelBatchResponse,
  type StockQuote,
} from '@/services/api';
import type { AssetType } from '@/types/asset';
import type { PortfolioCategory, PortfolioStock, PortfolioTickerEntry } from '@/types/portfolio';
import { addTickerToAmbushRadar, loadAmbushTickerEntries, notifyAmbushAddition } from '@/utils/ambush-storage';
import { createBackupPayload, parseBackupPayload, restoreBackupPayload, type BackupPayload } from '@/utils/backup';
import {
  applyCalibration,
  calibrateQuote,
  computeCalibrationFactor,
  DEFAULT_CALIBRATION_FACTOR,
  stripCalibration,
} from '@/utils/calibration';
import {
  deriveLocalValue,
  formatTotalValue,
  formatUnitPrice,
  getEffectiveUnits,
} from '@/utils/currency';
import { formatAmbushLines, formatPortfolioLines } from '@/utils/report-formatters';
import { buildPortfolioStock, computeHighestWatermark, toPortfolioTickerEntry } from '@/utils/portfolio-hydration';
import { normalizeTickerInput } from '@/utils/ticker';

type FilterOption = 'All' | PortfolioCategory;
const FILTER_OPTIONS: FilterOption[] = ['All', 'Core', 'Satellite', 'Quality'];

// ROBUST LANGUAGE CONTEXT: the filter chip's label — 'All' has its own
// dictionary key, the three categories reuse categoryLabel (same helper the
// SectionList headers and Add Asset modal's category picker use), so all
// three places agree on exactly the same translated text.
function filterOptionLabel(t: TFunction, filterOption: FilterOption): string {
  return filterOption === 'All' ? t('all') : categoryLabel(t, filterOption);
}

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
  // Core "Allocation Tracking": this layer's live share of the whole
  // portfolio (see computeLayerWeightPct) — computed once here, read by
  // every row in this section via the currentWeightPct prop, rather than
  // each row re-deriving it from the full stocks array.
  currentWeightPct: number;
  // CORE LAYER INTERNAL ALLOCATION FIX: this layer's own total market
  // value (see computeLayerTotalValue) — the denominator each row needs
  // to compute ITS OWN internal share of the layer (computeInternalWeightPct
  // in PortfolioStockRow), as opposed to currentWeightPct above, which is
  // this layer's share of the WHOLE portfolio. Computed once here, same
  // reasoning as currentWeightPct, rather than each row re-deriving it.
  layerTotalValue: number;
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

// CLOSED-LOOP WATCHLIST: only these layers move to the Ambush Radar when
// liquidated. Core is a long-term holding, not a tactical re-entry
// candidate.
const AMBUSH_MIGRATING_CATEGORIES: readonly PortfolioCategory[] = ['Satellite', 'Quality'];

// How long the liquidation toast stays fully visible before fading out.
const TOAST_DURATION_MS = 2500;

// Builds the Ambush Radar row for a liquidated position from data the
// Portfolio already has, so a mounted Ambush screen can show it at once
// without a network fetch that could fail. Price-like fields have this
// position's calibrationFactor stripped back off (see @/utils/calibration),
// because the Ambush Radar has no calibration concept and works on the
// API's raw values, the same ones its own next refresh will return.
// Ratio fields (drawdownPct, pullbackDepth) and trend labels don't change
// under calibration, so they're copied as-is.
function toAmbushStock(stock: PortfolioStock): Stock {
  const factor = stock.calibrationFactor ?? DEFAULT_CALIBRATION_FACTOR;
  const strip = (value: number | null): number | null => (value === null ? null : stripCalibration(value, factor));
  return {
    ticker: stock.ticker,
    assetType: stock.assetType,
    price: stripCalibration(stock.price, factor),
    localPrice: stripCalibration(stock.localPrice, factor),
    currencySymbol: stock.currencySymbol,
    sma50: strip(stock.sma50),
    sma200: strip(stock.sma200),
    macroTrend: stock.macroTrend,
    tacticalMomentum: stock.tacticalMomentum,
    anomalyReport: stock.anomalyReport,
    high52: strip(stock.high52),
    drawdownPct: stock.drawdownPct,
    pullbackDepth: stock.pullbackDepth,
    // An 'unavailable' position stays unavailable on the radar, so its
    // placeholder zeros never render there as a $0.00 price.
    priceStatus: stock.priceStatus,
  };
}


// TRAILING STOP DEFENSE CONSTRAINTS: a hardcoded architectural guard, not
// just a UI convenience gate — this is the ONLY function in the codebase
// allowed to compute a trailing-stop trigger price, and it refuses to
// return one for any category other than 'Satellite', no matter what
// highWaterMark it's handed. Core is held through drawdowns by design;
// Quality gets its own Fundamental Audit Kill Switch instead (see
// isFundamentalAuditRequired in PortfolioStockRow below) — neither may
// ever show or calculate a trailing stop. PortfolioStockRow's JSX ALSO
// gates its own render on `stock.category === 'Satellite'` independently
// (belt and suspenders, per the PRD's explicit "Hardcode a block"
// requirement) — this function existing at all is the second layer of
// that same block. Mirrors backend/main.py's identical guard inside
// _with_request_scoped_fields.
function computeSatelliteTrailingStopPrice(
  category: PortfolioCategory,
  highWaterMark: number | null,
): number | null {
  if (category !== 'Satellite') {
    return null;
  }
  if (highWaterMark === null) {
    return null;
  }
  return highWaterMark * (1 - SATELLITE_TS_PCT);
}

// ALLOCATION STATUS / Core "Allocation Tracking": the pure percentage
// calculation, shared by buildSectionTitle's header string below AND
// PortfolioStockRow's per-row "Allocation: X% / Target: 70%" line (Core
// layer only) — computed ONCE per layer here in PortfolioScreen (see
// allSections) rather than re-derived by every row, and threaded down via
// PortfolioListSection.currentWeightPct / the currentWeightPct prop.
//
// NOTE ON SOURCING: "The Fortress 2.0" overhaul's SQL migration
// (backend/sql/001_ui_pipeline_metrics.sql) defines this exact calculation
// as a Postgres window function (SUM(...) OVER (PARTITION BY asset_layer)
// / SUM(...) OVER ()) inside a `ui_pipeline_metrics` view — but that
// migration is NOT connected to any live database (see that file's own
// header comment), and the live FastAPI backend (backend/main.py) has no
// endpoint that could supply a `current_weight_pct` field even in
// principle: it's a stateless per-ticker proxy with zero visibility into a
// user's OTHER positions, which this calculation inherently needs. This
// stays a client-side computation for that reason — same formula the SQL
// view specifies, just not literally "read from the backend JSON" since no
// such JSON field exists yet.
//
// Both categoryStocks' contribution and totalPortfolioValue MUST be
// computed from `stock.price` (USD-normalized by the backend's
// Multi-Currency engine) — never `stock.localPrice`. Summing a Shekel
// value and a Dollar value directly would silently corrupt every
// percentage this produces; that's the exact "mathematical flaw" the
// Multi-Currency engine exists to fix.
//
// TASE ETF MATH FIX (Nominal Value / Erech Nakuv): a TASE-listed ETF's
// `units` is a Nominal Value quantity, not a real share count — 100
// nominal units = 1 real pricing unit — so it's converted via
// getEffectiveUnits before being multiplied by price, exactly like
// PortfolioStockRow's own position-total math below. Left unconverted, a
// held quantity like 1433 would be multiplied straight through instead of
// the ~14.33 real units it actually represents, inflating this layer's
// (and the whole portfolio's) computed value ~100x.
// Shared by computeLayerWeightPct (this layer's share of the WHOLE
// portfolio) and computeInternalWeightPct below (one asset's share of
// THIS layer alone) — both are "value / some total * 100", just with a
// different denominator, so the value-summing half is factored out once
// rather than duplicated. TASE ETF MATH FIX: getEffectiveUnits applies the
// Nominal Value / Erech Nakuv ÷100 conversion (see @/utils/currency) —
// without it, a TASE ETF's raw nominal `units` would be multiplied
// straight through, inflating this total ~100x.
function computeLayerTotalValue(categoryStocks: PortfolioStock[]): number {
  return categoryStocks.reduce(
    (sum, stock) => sum + getEffectiveUnits(stock.ticker, stock.assetType, stock.units) * stock.price,
    0,
  );
}

function computeLayerWeightPct(categoryStocks: PortfolioStock[], totalPortfolioValue: number): number {
  const categoryValue = computeLayerTotalValue(categoryStocks);
  return totalPortfolioValue > 0 ? (categoryValue / totalPortfolioValue) * 100 : 0;
}

// CORE LAYER INTERNAL ALLOCATION FIX: one asset's share of its OWN layer's
// total value — (Asset Total Value / Layer Total Value) * 100, exactly as
// specified — as opposed to computeLayerWeightPct above, which is that
// SAME layer's share of the WHOLE PORTFOLIO. Those are two genuinely
// different numbers (e.g. Core might be 68% of the whole portfolio, while
// one specific Core holding might be 40% of Core itself), and the bug
// this fixes was PortfolioStockRow displaying the former on every Core
// card when the latter is what actually tells a user how their own Core
// holdings are balanced against EACH OTHER. Returns 0 (not NaN/Infinity)
// when the layer is empty/worthless, matching computeLayerWeightPct's own
// zero-division guard.
function computeInternalWeightPct(stock: PortfolioStock, layerTotalValue: number): number {
  const stockValue = getEffectiveUnits(stock.ticker, stock.assetType, stock.units) * stock.price;
  return layerTotalValue > 0 ? (stockValue / layerTotalValue) * 100 : 0;
}

// Builds the "<layer> (Target: X% | Actual: Y%) - N Assets" section-header
// string — target from the fixed Fortress 2.0 Model (CATEGORY_TARGET_PCT),
// actual is the SAME currentWeightPct computed once in allSections below
// (not re-derived here), and N the number of tickers in it.
//
// This is a single translated-word-first string (categoryLabel(...) always
// comes first), which is bidi-safe as one <Text> node — unlike the
// number-first units/price row in PortfolioStockRow, see the RTL MIXED
// TEXT RENDERING FIX note there.
function buildSectionTitle(
  t: TFunction,
  category: PortfolioCategory,
  categoryStocks: PortfolioStock[],
  currentWeightPct: number,
): string {
  return (
    `${categoryLabel(t, category)} (${t('target')}: ${CATEGORY_TARGET_PCT[category]}% | ` +
    `${t('actual')}: ${currentWeightPct.toFixed(1)}%) - ${categoryStocks.length} ${t('assets')}`
  );
}

// The Fortress 2.0 Model: a 70/20/10 allocation across Core, Satellites, and
// Quality positions.
export default function PortfolioScreen() {
  const [stocks, setStocks] = useState<PortfolioStock[]>([]);
  // CACHE INTEGRITY (AppState/hydration safety): the persistence effect
  // below (which mirrors `stocks` into AsyncStorage) used to gate purely
  // on `!isInitializing` — but `isInitializing` flips to false on EVERY
  // exit path out of the initial load, including the "storage read
  // failed" and "every live-quote fetch failed" bail-outs, which
  // deliberately leave `stocks` untouched at its initial `[]`. The old
  // gate couldn't tell "we loaded nothing because there's genuinely
  // nothing saved" apart from "we loaded nothing because the fetch/read
  // just failed" — and in that second case, the persistence effect would
  // still fire once isInitializing went false, writing that empty `[]`
  // straight over the real portfolio still sitting untouched in
  // AsyncStorage. THIS was the actual data-loss bug (observed on Android:
  // backgrounding the app mid-load lets the OS fail/suspend the in-flight
  // fetch, which used to permanently wipe the saved portfolio on disk,
  // not just the on-screen list).
  //
  // canPersistRef is the fix: it starts false and is flipped true ONLY by
  // setStocksTrusted below, which every call site that has genuinely
  // trustworthy data (a successful load/refresh, or a deliberate user
  // edit) already uses instead of calling setStocks directly. A failed
  // load that bails out without calling setStocksTrusted at all leaves
  // this false, so the persistence effect keeps refusing to write —
  // AsyncStorage is never overwritten with an empty array just because a
  // fetch failed or was interrupted. A plain ref (not state) is
  // deliberate: flipping it must never itself trigger a re-render/extra
  // effect pass — it only needs to be read inside the SAME effect that
  // `stocks`/`isInitializing` already re-run.
  const canPersistRef = useRef(false);

  const setStocksTrusted = useCallback(
    (update: PortfolioStock[] | ((previous: PortfolioStock[]) => PortfolioStock[])) => {
      canPersistRef.current = true;
      setStocks(update);
    },
    [],
  );

  // STATE PROTECTION: a subtle, non-blocking banner (never a blocking
  // Alert/modal) shown when a background/foreground resync or the initial
  // load couldn't reach the server — the existing on-screen data (or, on
  // a cold start that never even got that far, an empty list) stays
  // exactly as it was; this is purely informational. Cleared the moment
  // any subsequent load/refresh actually succeeds.
  const [syncWarning, setSyncWarning] = useState(false);
  const [ticker, setTicker] = useState('');
  const [units, setUnits] = useState('1');
  // AUTO-CALIBRATION FOR BROKEN PRICES: optional — see handleAddTicker for
  // how this becomes a calibrationFactor. Left blank, the position is
  // added with no correction at all (factor 1.0, i.e. trust the API price
  // as-is).
  const [totalValueInput, setTotalValueInput] = useState('');
  // QUALITY Z-SCORE MODULE: optional, relevant for Quality positions only
  // (see the "ROIC" field's own conditional render below) — see
  // handleAddTicker for how this becomes a PortfolioTickerEntry.roic.
  const [roicInput, setRoicInput] = useState('');
  // CORE LAYER INTERNAL ALLOCATION: optional, relevant for Core positions
  // only (see the "Internal Target" field's own conditional render below)
  // — see handleAddTicker for how this becomes a
  // PortfolioTickerEntry.internalTargetPct.
  const [internalTargetInput, setInternalTargetInput] = useState('');
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
  const { language, setLanguage, t } = usePipelineLanguage();
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
      section.data.length === 0 ? (
        <Text style={styles.sectionEmptyText}>{t('noPositionsYet')}</Text>
      ) : null,
    [styles, t],
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

  // Tracks whether this screen is still mounted — read (not just set) from
  // loadPortfolioData below, which can now be invoked long after mount
  // (from the AppState foreground hook), not only from the one-time mount
  // effect that originally owned this flag.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Loads the saved portfolio: reads the ticker/category pairs from
  // AsyncStorage, then fetches a fresh live price for each from the Python
  // API. Used both on mount AND re-triggered from the AppState foreground
  // hook below (useAppForegroundRefresh) whenever the initial load never
  // actually got real data into `stocks` (canPersistRef.current is still
  // false) — e.g. the app was backgrounded mid-load on Android and the OS
  // suspended/failed the in-flight fetch. A plain useCallback (not inlined
  // in a useEffect) specifically so it has that second call site.
  const loadPortfolioData = useCallback(async () => {
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
      // Entries saved before "units", "assetType", "highestWatermark",
      // "calibrationFactor", "roic", or "internalTargetPct" existed
      // won't have valid values; backfill them rather than letting
      // totals/trailing-stop math break on undefined/NaN.
      // calibrationFactor is left undefined (not coerced to 1.0) for old
      // entries so calibrateQuote's DEFAULT_CALIBRATION_FACTOR fast path
      // still applies.
      entries = parsed.map((entry) => ({
        ticker: entry.ticker ?? '',
        category: entry.category ?? 'Core',
        units: typeof entry.units === 'number' && entry.units > 0 ? entry.units : 1,
        assetType: entry.assetType === 'ETF' ? 'ETF' : 'Stock',
        highestWatermark:
          typeof entry.highestWatermark === 'number' ? entry.highestWatermark : null,
        calibrationFactor:
          typeof entry.calibrationFactor === 'number' && entry.calibrationFactor > 0
            ? entry.calibrationFactor
            : undefined,
        // QUALITY Z-SCORE MODULE: entries saved before this feature
        // existed won't have a roic at all; backfill to null (never
        // evaluated as "no ROIC entered") rather than 0 (which would
        // read as a genuinely terrible ROIC).
        roic: typeof entry.roic === 'number' ? entry.roic : null,
        // CORE LAYER INTERNAL ALLOCATION: same backfill reasoning as
        // roic above — null means "no internal target defined", not 0%.
        internalTargetPct: typeof entry.internalTargetPct === 'number' ? entry.internalTargetPct : null,
      }));
    } catch (error) {
      console.error(
        '[hydration] Failed to read the Portfolio from storage; retaining the previous ' +
          'state instead of overwriting it with an empty portfolio.',
        error,
      );
      // CACHE INTEGRITY: deliberately NOT setStocksTrusted — canPersistRef
      // stays false, so the persistence effect below keeps refusing to
      // write until a load actually succeeds. STATE PROTECTION: a subtle
      // banner, never a cleared list.
      if (isMountedRef.current) {
        setSyncWarning(true);
        setIsInitializing(false);
      }
      return;
    }

    if (entries.length === 0) {
      // A genuinely empty, successfully-read portfolio (the user deleted
      // every position) is valid state, not a failure — show it as-is,
      // and this IS trustworthy enough to persist (storage was read
      // successfully; it was just empty).
      if (isMountedRef.current) {
        setStocksTrusted([]);
        setSyncWarning(false);
        setIsInitializing(false);
      }
      return;
    }

    // CONCURRENCY LIMITING: fetched in small batches (not one giant
    // Promise.allSettled over the whole portfolio at once) to avoid
    // overwhelming the network with N simultaneous connections — this
    // still awaits the full queue before moving on, so isInitializing
    // below only flips to false once every batch has resolved.
    const results = await fetchInChunks(entries, (entry) =>
      // QUALITY Z-SCORE MODULE: roic is already known from the persisted
      // entry at this point (unlike qualityWeightPct, which needs every
      // position's price already loaded — see onRefresh for where that
      // gets threaded through instead), so it's sent from the very first
      // fetch. highWaterMark is intentionally omitted here: this is each
      // position's FIRST fetch of the session, so there's nothing yet to
      // compare against beyond what computeHighestWatermark below already
      // does client-side.
      fetchStockData(entry.ticker, entry.category, { roic: entry.roic }),
    );

    // DATA-LOSS FIX: one row per stored entry, ALWAYS, in storage order. A
    // ticker whose fetch failed (network error, timeout, the OS suspending
    // the request while backgrounded, a ticker the API can't find) becomes
    // an 'unavailable' row instead of being dropped. The old code kept only
    // the fulfilled results, so the persistence effect then saved that
    // shorter list and permanently deleted every position whose fetch
    // happened to fail. Because this list now matches storage entry for
    // entry, it is safe to mark trusted and persist even when EVERY fetch
    // failed: saving it writes back exactly what was read.
    const loadedStocks = entries.map((entry, index) => {
      const result = results[index];
      return buildPortfolioStock(entry, result.status === 'fulfilled' ? result.value : null);
    });

    const failedCount = results.filter((result) => result.status === 'rejected').length;
    if (failedCount > 0) {
      console.error(
        `[hydration] ${failedCount} of ${entries.length} position fetch(es) failed; keeping ` +
          'those positions with an unavailable price instead of dropping them.',
      );
    }

    if (isMountedRef.current) {
      setStocksTrusted(loadedStocks);
      // The screen-level banner is for a sync-wide failure (nothing came
      // back at all). A partial failure shows on the affected rows only.
      setSyncWarning(failedCount === entries.length);
      setIsInitializing(false);
    }
  }, [setStocksTrusted]);

  // Load the saved portfolio on mount.
  useEffect(() => {
    loadPortfolioData();
  }, [loadPortfolioData]);

  // Declared here (ABOVE the useAppForegroundRefresh call below, which
  // reads it) rather than down near the other handleXxx functions where
  // it used to live — a function used by a hook call must be declared
  // before that call lexically, or React's own compiler/lint rules flag
  // it as "accessed before declared," even though the actual runtime
  // behavior is identical either way (the hook only ever invokes this
  // asynchronously, long after the whole component body has finished
  // executing for that render).
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      // Refreshes from the live `stocks` array (not just a plain ticker
      // string list) so each request can carry that position's own
      // category — see fetchStockData's `category` param — for the
      // Satellite/Quality-keyed Mean Reversion threshold, same as every
      // other fetch site below.
      const stocksToRefresh = stocks;

      if (stocksToRefresh.length === 0) {
        // Nothing to refresh — either a genuinely empty portfolio, or the
        // initial load never got real data in (see loadPortfolioData's
        // own canPersistRef comment). Either way, mapping an empty array
        // is a pure no-op, so skip it entirely rather than calling
        // setStocksTrusted with an empty result: that would wrongly mark
        // canPersistRef as trustworthy and let the persistence effect
        // below write this still-empty `[]` over whatever real data is
        // (or isn't) actually sitting in AsyncStorage.
        return;
      }
      // QUALITY Z-SCORE MODULE: the Quality layer's weight from the
      // portfolio composition just BEFORE this refresh (same
      // computeLayerWeightPct/getEffectiveUnits math the render body uses
      // for its own qualityWeightPct below) — the closest approximation
      // available without a circular fetch-then-recompute-then-refetch
      // dance. Every non-Quality stock simply omits qualityWeightPct
      // entirely (see StockDataOptions), same as it omits roic gating that
      // doesn't apply to it.
      const previousTotalPortfolioValue = stocksToRefresh.reduce(
        (sum, stock) => sum + getEffectiveUnits(stock.ticker, stock.assetType, stock.units) * stock.price,
        0,
      );
      const previousQualityWeightPct = computeLayerWeightPct(
        stocksToRefresh.filter((stock) => stock.category === 'Quality'),
        previousTotalPortfolioValue,
      );
      // CONCURRENCY LIMITING: see loadInitialStocks above — small batches,
      // not one Promise.allSettled over the whole list.
      const results = await fetchInChunks(stocksToRefresh, (stock) =>
        fetchStockData(stock.ticker, stock.category, {
          roic: stock.roic,
          qualityWeightPct: stock.category === 'Quality' ? previousQualityWeightPct : undefined,
        }),
      );

      const freshQuotes = new Map<string, StockQuote>();
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          freshQuotes.set(stocksToRefresh[index].ticker, result.value);
        }
      });

      // STATE PROTECTION: every single refresh attempt failed (network
      // outage, or the app got backgrounded mid-refresh and the OS
      // suspended the request) — every position below falls through to
      // `return stock` unchanged, so nothing is lost, but the user should
      // still see a subtle signal that this refresh didn't actually reach
      // the server. A PARTIAL failure (some tickers refreshed, others
      // didn't) is treated as success — that's normal, everyday flakiness
      // for one ticker, not a sync-wide problem worth surfacing.
      if (freshQuotes.size === 0) {
        console.error(
          '[sync] All position refresh(es) failed (network issue, or the app was backgrounded ' +
            'mid-refresh); retaining the current portfolio instead of clearing it.',
        );
        setSyncWarning(true);
        return;
      }
      setSyncWarning(false);

      // A ticker whose refresh failed keeps its current row unchanged (last
      // good price, or still 'unavailable'). A successful one goes through
      // buildPortfolioStock, which re-applies this position's calibration
      // and sets priceStatus back to 'live', so a row that failed on load
      // recovers on the next successful refresh.
      setStocksTrusted((prevStocks) =>
        prevStocks.map((stock) => {
          const freshQuote = freshQuotes.get(stock.ticker);
          return freshQuote ? buildPortfolioStock(stock, freshQuote) : stock;
        }),
      );
    } finally {
      setRefreshing(false);
    }
  };

  // ANDROID BACKGROUND/FOREGROUND DATA HYDRATION FIX (requirement #2): once
  // the app returns to the foreground after being backgrounded, re-sync
  // with the server rather than silently trusting whatever (possibly
  // nothing, if the initial load got interrupted) is currently on screen.
  // Two different recoveries, depending on how far the app actually got:
  //   - canPersistRef.current is false: the initial load never landed real
  //     data (it was still in flight, or failed outright, when backgrounded
  //     — see loadPortfolioData's own comments) — re-run the FULL load,
  //     since a lightweight refresh would have nothing in `stocks` to
  //     refresh in the first place.
  //   - canPersistRef.current is true: there's already real data on
  //     screen — a full reload would be wasteful and would flash the
  //     big "Loading your portfolio..." spinner for no reason, so just
  //     re-run the same lightweight onRefresh pull-to-refresh already uses
  //     to re-sync prices for the positions already showing.
  // Deliberately a plain inline function, NOT wrapped in useCallback:
  // useAppForegroundRefresh already re-captures whatever function is
  // passed to it on every single render (see its own "always points at
  // the LATEST onForeground closure" comment) specifically so its callers
  // never need to worry about memoizing this or listing onRefresh as a
  // dependency — onRefresh itself is redefined fresh every render too.
  useAppForegroundRefresh(() => {
    if (canPersistRef.current) {
      onRefresh();
    } else {
      loadPortfolioData();
    }
  });

  // CACHE INTEGRITY: keep AsyncStorage in sync with the current portfolio
  // — but ONLY once there's trustworthy data to sync. Skipped while
  // initializing so we don't overwrite storage before the saved list
  // loads, AND skipped whenever canPersistRef is still false — see its
  // own declaration above for exactly which failure paths that covers
  // (a storage read failure, or every live-quote fetch failing, both of
  // which flip isInitializing to false WITHOUT ever putting trustworthy
  // data into `stocks`). Without this second check, `stocks` sitting at
  // its untouched initial `[]` would get written straight over the real,
  // still-intact AsyncStorage data the instant isInitializing goes false
  // — which is the exact data-loss bug this whole mechanism exists to
  // prevent.
  useEffect(() => {
    if (isInitializing || !canPersistRef.current) {
      return;
    }

    // Persisted fields only (see toPortfolioTickerEntry). Every row is
    // included, 'unavailable' ones too, so this list is never shorter than
    // what was loaded.
    const entries: PortfolioTickerEntry[] = stocks.map(toPortfolioTickerEntry);
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
      Alert.alert(t('invalidUnitsTitle'), t('invalidUnitsMessage'));
      return;
    }

    if (stocks.some((stock) => stock.ticker === normalizedTicker)) {
      setTicker('');
      return;
    }

    // QUALITY Z-SCORE MODULE: blank means "no ROIC entered" (null), never
    // 0 — same "blank input degrades to a safe no-op" pattern as the Total
    // Value field above/below.
    const trimmedRoicInput = roicInput.trim();
    const parsedRoic = trimmedRoicInput === '' ? null : Number(trimmedRoicInput);
    const roic = parsedRoic !== null && Number.isFinite(parsedRoic) ? parsedRoic : null;

    // CORE LAYER INTERNAL ALLOCATION: blank means "no internal target
    // entered" (null), same "blank input degrades to a safe no-op"
    // pattern as roic just above.
    const trimmedInternalTargetInput = internalTargetInput.trim();
    const parsedInternalTarget =
      trimmedInternalTargetInput === '' ? null : Number(trimmedInternalTargetInput);
    const internalTargetPct =
      parsedInternalTarget !== null && Number.isFinite(parsedInternalTarget) ? parsedInternalTarget : null;

    setIsAdding(true);
    try {
      // qualityWeightPct here is this render's already-computed Quality
      // layer weight (see computeLayerWeightPct below) — the portfolio's
      // composition just BEFORE this new position is added, the closest
      // approximation available without a circular fetch-then-recompute-
      // then-refetch dance. Only meaningful when selectedCategory is
      // 'Quality'; harmless to always send otherwise (the backend's alert
      // gate only ever fires for a Quality-category z_score to begin with).
      const quote = await fetchStockData(normalizedTicker, selectedCategory, {
        roic,
        qualityWeightPct,
      });

      // AUTO-CALIBRATION FOR BROKEN PRICES: quote.localPrice here is the
      // RAW, freshly-fetched API value — nothing has calibrated it yet, so
      // it's exactly what computeCalibrationFactor needs as its reference
      // price. An empty/invalid Total Value input degrades to
      // DEFAULT_CALIBRATION_FACTOR (1.0, a no-op) rather than blocking the
      // add — this field is explicitly optional.
      const parsedTotalValue = totalValueInput.trim() === '' ? null : Number(totalValueInput);
      const calibrationFactor = computeCalibrationFactor(parsedTotalValue, parsedUnits, quote.localPrice);
      const calibratedQuote = calibrateQuote(quote, calibrationFactor);

      setStocksTrusted((prevStocks) => [
        ...prevStocks,
        {
          ticker: normalizedTicker,
          category: selectedCategory,
          assetType: selectedAssetType,
          units: parsedUnits,
          price: calibratedQuote.price,
          localPrice: calibratedQuote.localPrice,
          currencySymbol: calibratedQuote.currencySymbol,
          anomalyReport: calibratedQuote.anomalyReport,
          high52: calibratedQuote.high52,
          drawdownPct: calibratedQuote.drawdownPct,
          sma50: calibratedQuote.sma50,
          sma200: calibratedQuote.sma200,
          macroTrend: calibratedQuote.macroTrend,
          tacticalMomentum: calibratedQuote.tacticalMomentum,
          pullbackDepth: calibratedQuote.pullbackDepth,
          qualityZScore: calibratedQuote.qualityZScore,
          qualityZScoreAlert: calibratedQuote.qualityZScoreAlert,
          // Always 'live': a ticker is only added after its fetch succeeds.
          priceStatus: calibratedQuote.priceStatus,
          highestWatermark: computeHighestWatermark(null, calibratedQuote.price),
          calibrationFactor,
          roic,
          internalTargetPct,
        },
      ]);
      setTicker('');
      setUnits('1');
      setTotalValueInput('');
      setRoicInput('');
      setInternalTargetInput('');
      setIsAddModalVisible(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('fetchFailedForTicker', { ticker: normalizedTicker });
      Alert.alert(t('cannotAddTickerTitle'), message);
    } finally {
      setIsAdding(false);
    }
  };

  // Stable identity (useCallback) is required for the React.memo on
  // PortfolioStockRow to actually skip re-renders — an inline function here
  // would be a new reference on every PortfolioScreen render, which would
  // defeat memo() by changing this prop for every row on every render.
  // Subtle, non-blocking feedback toast (never an Alert), used for the
  // liquidation message below. Fades in, stays TOAST_DURATION_MS, fades
  // out. A new message replaces the current one and restarts the timer.
  // Starting the fade-in stops any fade-out in progress, so that fade-out's
  // `finished` is false and it doesn't clear the new message.
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastOpacity] = useState(() => new Animated.Value(0));
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current !== null) {
        clearTimeout(toastTimeoutRef.current);
      }
    };
  }, []);

  const showToast = useCallback(
    (message: string) => {
      if (toastTimeoutRef.current !== null) {
        clearTimeout(toastTimeoutRef.current);
      }
      setToastMessage(message);
      Animated.timing(toastOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
      toastTimeoutRef.current = setTimeout(() => {
        toastTimeoutRef.current = null;
        Animated.timing(toastOpacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(({ finished }) => {
          if (finished) {
            setToastMessage(null);
          }
        });
      }, TOAST_DURATION_MS);
    },
    [toastOpacity],
  );

  // CLOSED-LOOP WATCHLIST: deleting a position is a full liquidation.
  //   1. The row leaves the portfolio immediately, so the UI never waits
  //      on storage or the network.
  //   2. The deletion is mirrored to the backend (DELETE /api/portfolio/
  //      {ticker}) as fire-and-forget. That endpoint answers 503 until a
  //      database is configured, which is expected and ignored here.
  //   3. Satellite/Quality positions are added to the on-device Ambush
  //      Radar list (the actual source of truth today), skipping
  //      duplicates. A mounted Ambush screen is told directly (see
  //      notifyAmbushAddition), and a toast confirms the result.
  // A storage failure in step 3 does NOT undo the deletion: removing the
  // position is what the user asked for, and the radar entry is a follow-
  // on. The toast says plainly that the radar step failed.
  const liquidatePosition = useCallback(
    (stockToDelete: PortfolioStock) => {
      const { ticker: deletedTicker, assetType, category } = stockToDelete;
      setStocksTrusted((prevStocks) => prevStocks.filter((stock) => stock.ticker !== deletedTicker));

      liquidatePortfolioAsset(deletedTicker, assetType).catch(() => {
        // Expected today (503: no database configured). The on-device
        // storage below is what the app actually reads.
      });

      if (!AMBUSH_MIGRATING_CATEGORIES.includes(category)) {
        return;
      }

      addTickerToAmbushRadar({ ticker: deletedTicker, assetType })
        .then((result) => {
          notifyAmbushAddition(toAmbushStock(stockToDelete));
          showToast(
            t(result === 'added' ? 'liquidatedMovedToAmbush' : 'liquidatedAlreadyOnAmbush', {
              ticker: deletedTicker,
            }),
          );
        })
        .catch((error) => {
          console.error(`[ambush] Failed to add liquidated ${deletedTicker} to the Ambush Radar:`, error);
          showToast(t('liquidatedAmbushFailed', { ticker: deletedTicker }));
        });
    },
    [setStocksTrusted, showToast, t],
  );

  // DELETE CONFIRMATION: the row's ✕ never deletes directly. Liquidation
  // removes the position and (for Satellite/Quality) moves it to the Ambush
  // Radar, so it only runs after a deliberate "Yes, Liquidate". Cancel,
  // the Android back button, or tapping outside the dialog
  // (cancelable: true) all leave the position untouched. Stable identity
  // (useCallback) keeps PortfolioStockRow's memo() effective.
  const handleDeleteTicker = useCallback(
    (stockToDelete: PortfolioStock) => {
      Alert.alert(
        t('liquidateConfirmTitle'),
        t('liquidateConfirmMessage', { ticker: stockToDelete.ticker }),
        [
          { text: t('cancel'), style: 'cancel' },
          { text: t('yesLiquidate'), style: 'destructive', onPress: () => liquidatePosition(stockToDelete) },
        ],
        { cancelable: true },
      );
    },
    [liquidatePosition, t],
  );

  const handleSaveEdit = useCallback(
    (
      tickerToUpdate: string,
      newUnits: number,
      newAssetType: AssetType,
      newTotalValueInput: string,
      newRoicInput: string,
      newInternalTargetInput: string,
    ) => {
      setStocksTrusted((prevStocks) =>
        prevStocks.map((stock) => {
          if (stock.ticker !== tickerToUpdate) {
            return stock;
          }

          // The watermark is now tracked for every asset type (Satellite
          // ETFs need it for their own trailing stop too — see
          // SATELLITE_ETF_TS_PCT), so switching between Stock and ETF no
          // longer resets it: keep whatever was already being tracked, or
          // seed it from the current price if this position never had one.
          // DATA-LOSS FIX: an 'unavailable' row's price is only a placeholder
          // 0, so it never seeds a missing watermark.
          const highestWatermark =
            stock.highestWatermark ?? (stock.priceStatus === 'live' ? stock.price : null);

          // QUALITY Z-SCORE MODULE: a BLANK ROIC field here PRESERVES this
          // position's existing roic unchanged — same "blank means leave
          // it alone" reasoning as the Total Value field just below, not
          // "blank means clear it to null" (that would silently wipe out a
          // previously-entered ROIC just because this unrelated edit left
          // the field blank, which on Edit is the common case).
          const trimmedRoicInput = newRoicInput.trim();
          const parsedRoic = trimmedRoicInput === '' ? null : Number(trimmedRoicInput);
          const roic = trimmedRoicInput === '' || !Number.isFinite(parsedRoic) ? stock.roic : parsedRoic;

          // CORE LAYER INTERNAL ALLOCATION: same "blank preserves the
          // existing value" reasoning as roic just above.
          const trimmedInternalTargetInput = newInternalTargetInput.trim();
          const parsedInternalTarget =
            trimmedInternalTargetInput === '' ? null : Number(trimmedInternalTargetInput);
          const internalTargetPct =
            trimmedInternalTargetInput === '' || !Number.isFinite(parsedInternalTarget)
              ? stock.internalTargetPct
              : parsedInternalTarget;

          // AUTO-CALIBRATION FOR BROKEN PRICES: a BLANK Total Value field
          // here deliberately PRESERVES this position's existing
          // calibrationFactor unchanged, rather than resetting it to 1.0 —
          // unlike the Add Asset flow (where blank truly means "no
          // correction was ever entered"), on Edit the user is very often
          // here only to bump the unit count, and silently un-calibrating
          // an already-corrected position just because they left this
          // unrelated field blank would quietly wipe out a correction they
          // made earlier. A calibrationFactor is only ever REPLACED when
          // the user explicitly enters a new Total Value.
          const parsedTotalValue = newTotalValueInput.trim() === '' ? null : Number(newTotalValueInput);
          // DATA-LOSS FIX: recalibrating needs the real fetched price. On
          // an 'unavailable' row it would compute against the placeholder
          // 0, reset calibrationFactor to 1.0, and set the watermark to 0,
          // destroying both. So a Total Value entered while the price is
          // unavailable is ignored; units/type/roic/target still save.
          if (
            stock.priceStatus === 'unavailable' ||
            parsedTotalValue === null ||
            !Number.isFinite(parsedTotalValue) ||
            parsedTotalValue <= 0
          ) {
            return {
              ...stock,
              units: newUnits,
              assetType: newAssetType,
              highestWatermark,
              roic,
              internalTargetPct,
            };
          }

          // Recalibrating: stock.price/localPrice/high52/sma50/sma200 are
          // already calibrated (see calibrateQuote) — strip the OLD factor
          // back off to recover the raw Yahoo figures, then compute and
          // apply a NEW factor from the fresh Total Value against those
          // same raw figures. macroTrend/tacticalMomentum are untouched —
          // they're a price-vs-SMA ratio comparison, unaffected by scaling
          // both sides by the same factor (see calibrateQuote's own
          // comment). The old highestWatermark's basis is no longer valid
          // once the scale changes, so it's reseeded from the newly
          // corrected price instead of carried forward stale.
          const existingFactor = stock.calibrationFactor ?? DEFAULT_CALIBRATION_FACTOR;
          const rawLocalPrice = stripCalibration(stock.localPrice, existingFactor);
          const rawUsdPrice = stripCalibration(stock.price, existingFactor);
          const rawHigh52 = stock.high52 !== null ? stripCalibration(stock.high52, existingFactor) : null;
          const rawSma50 = stock.sma50 !== null ? stripCalibration(stock.sma50, existingFactor) : null;
          const rawSma200 = stock.sma200 !== null ? stripCalibration(stock.sma200, existingFactor) : null;

          const calibrationFactor = computeCalibrationFactor(parsedTotalValue, newUnits, rawLocalPrice);
          const newLocalPrice = applyCalibration(rawLocalPrice, calibrationFactor);
          const newUsdPrice = applyCalibration(rawUsdPrice, calibrationFactor);
          const newHigh52 = rawHigh52 !== null ? applyCalibration(rawHigh52, calibrationFactor) : null;
          const newSma50 = rawSma50 !== null ? applyCalibration(rawSma50, calibrationFactor) : null;
          const newSma200 = rawSma200 !== null ? applyCalibration(rawSma200, calibrationFactor) : null;

          return {
            ...stock,
            units: newUnits,
            assetType: newAssetType,
            price: newUsdPrice,
            localPrice: newLocalPrice,
            high52: newHigh52,
            sma50: newSma50,
            sma200: newSma200,
            calibrationFactor,
            highestWatermark: newUsdPrice,
            roic,
            internalTargetPct,
          };
        }),
      );
    },
    [setStocksTrusted],
  );

  const renderPortfolioRow = useCallback(
    ({ item, section }: { item: PortfolioStock; section: PortfolioListSection }) => (
      <PortfolioStockRow
        stock={item}
        accentColor={section.accentColor}
        layerTotalValue={section.layerTotalValue}
        onDelete={handleDeleteTicker}
        onSaveEdit={handleSaveEdit}
        colors={colors}
        styles={styles}
        language={language}
        t={t}
      />
    ),
    [handleDeleteTicker, handleSaveEdit, colors, styles, language, t],
  );

  const handleCopyPortfolioData = async () => {
    const timestamp = new Date().toLocaleString();
    const report = [`Pipeline Portfolio Report — ${timestamp}`, '', ...formatPortfolioLines(stocks)].join(
      '\n',
    );

    try {
      await Clipboard.setStringAsync(report);
      Alert.alert(t('copiedTitle'), t('portfolioDataCopiedMessage'));
    } catch {
      Alert.alert(t('copyFailedTitle'), t('copyPortfolioFailedMessage'));
    }
  };

  const handleCopyAllData = async () => {
    setIsExportingAll(true);
    try {
      const ambushEntries = (await loadAmbushTickerEntries()) ?? [];

      // CONCURRENCY LIMITING: see loadInitialStocks above.
      const ambushResults = await fetchInChunks(ambushEntries, (entry) => fetchStockData(entry.ticker));

      // Every watched ticker appears in the export; one whose fetch failed
      // is listed as price-unavailable rather than silently left out.
      const ambushStocks: Stock[] = ambushEntries.map((entry, index) => {
        const result = ambushResults[index];
        return { ...entry, ...(result.status === 'fulfilled' ? result.value : createUnavailableQuote()) };
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
      Alert.alert(t('copiedTitle'), t('allDataCopiedMessage'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('combinedExportFailedMessage');
      Alert.alert(t('copyFailedTitle'), message);
    } finally {
      setIsExportingAll(false);
    }
  };

  const handleExportBackup = async () => {
    setIsExportingBackup(true);
    try {
      const payload = await createBackupPayload();
      await Clipboard.setStringAsync(JSON.stringify(payload));
      Alert.alert(t('backupExportedTitle'), t('backupExportedMessage'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('backupExportFailedMessage');
      Alert.alert(t('exportFailedTitle'), message);
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
      const message = error instanceof Error ? error.message : t('invalidBackupMessage');
      Alert.alert(t('invalidBackupTitle'), message);
      return;
    }

    setIsRestoring(true);
    try {
      await restoreBackupPayload(payload);

      // Update this screen's own live state immediately (mirrors the
      // initial-load flow); Ambush Radar's separate mounted screen picks up
      // its half of the restore the next time its tab gains focus.
      // CONCURRENCY LIMITING: see loadInitialStocks above.
      // QUALITY Z-SCORE MODULE: roic round-trips through the backup JSON
      // (see coercePortfolioEntry in @/utils/backup) and is already known
      // per-entry; qualityWeightPct is omitted here, same reasoning as
      // loadInitialStocks — there's no prior portfolio composition to
      // approximate it from right after a restore, so the alert simply
      // stays inactive until the next pull-to-refresh.
      const results = await fetchInChunks(payload.portfolio, (entry) =>
        fetchStockData(entry.ticker, entry.category, { roic: entry.roic }),
      );

      // DATA-LOSS FIX: one row per restored entry, ALWAYS; a failed fetch
      // becomes an 'unavailable' row. The old code kept only fulfilled
      // results, so a partial failure saved a shorter list over the
      // just-restored storage. A total failure was worse: it kept showing
      // the OLD portfolio while storage held the restored one, and the next
      // save wrote the old list back over the restore. Now the screen
      // always matches what was just written to storage.
      const hydratedStocks = payload.portfolio.map((entry, index) => {
        const result = results[index];
        return buildPortfolioStock(entry, result.status === 'fulfilled' ? result.value : null);
      });
      const allFetchesFailed =
        payload.portfolio.length > 0 && results.every((result) => result.status === 'rejected');

      setIsImportModalVisible(false);
      setImportText('');
      setStocksTrusted(hydratedStocks);
      setSyncWarning(allFetchesFailed);

      if (allFetchesFailed) {
        console.error(
          `[hydration] Backup restored, but all ${payload.portfolio.length} live price fetch(es) ` +
            'failed; showing the restored positions with unavailable prices.',
        );
        Alert.alert(t('backupRestoredTitle'), t('backupRestoredPricesFailedMessage'));
        return;
      }

      Alert.alert(t('backupRestoredTitle'), t('backupRestoredMessage'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('backupRestoreFailedMessage');
      Alert.alert(t('restoreFailedTitle'), message);
    } finally {
      setIsRestoring(false);
    }
  };

  const handleFetchIntel = async () => {
    if (!intelInput.trim()) {
      Alert.alert(t('tickerRequiredTitle'), t('tickerRequiredMessage'));
      return;
    }

    setIsFetchingIntel(true);
    setIntelResult(null);
    try {
      const result = await fetchIntel(intelInput);
      setIntelResult(result);

      const hasAnyNews = result.results.some((entry) => entry.news.length > 0);
      if (!hasAnyNews) {
        Alert.alert(t('noNewsFoundTitle'), t('noNewsFoundMessage'));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('intelFetchFailedMessage');
      Alert.alert(t('intelFetchFailedTitle'), message);
    } finally {
      setIsFetchingIntel(false);
    }
  };

  const handleOpenArticleLink = (url: string) => {
    Linking.openURL(url).catch(() => {
      Alert.alert(t('cannotOpenLinkTitle'), t('cannotOpenLinkMessage'));
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
      Alert.alert(t('copiedTitle'), t('intelCopiedMessage'));
    } catch {
      Alert.alert(t('copyFailedTitle'), t('intelCopyFailedMessage'));
    }
  };

  // ALLOCATION STATUS: both the per-layer contribution and this grand
  // total are `effectiveUnits * price` (USD) — never `localPrice` — so a
  // Shekel TASE position and a Dollar US position sum together correctly.
  // TASE ETF MATH FIX: getEffectiveUnits applies the Nominal Value / Erech
  // Nakuv ÷100 conversion for TASE ETFs (see its own comment in
  // @/utils/currency) — without it, a TASE ETF's raw nominal `units` would
  // be multiplied straight through, inflating this total ~100x for any
  // portfolio holding one. See buildSectionTitle above for how this feeds
  // the section headers.
  const coreStocks = stocks.filter((stock) => stock.category === 'Core');
  const satelliteStocks = stocks.filter((stock) => stock.category === 'Satellite');
  const qualityStocks = stocks.filter((stock) => stock.category === 'Quality');
  const totalPortfolioValue = stocks.reduce(
    (sum, stock) => sum + getEffectiveUnits(stock.ticker, stock.assetType, stock.units) * stock.price,
    0,
  );

  // Computed ONCE per layer here (see computeLayerWeightPct's own comment
  // for why this stays client-side rather than a literal backend JSON
  // read) — reused for this section's header string. CORE LAYER INTERNAL
  // ALLOCATION FIX: each layer's OWN total value (computeLayerTotalValue)
  // is now ALSO computed once here and threaded through as
  // layerTotalValue, so every row can derive ITS OWN internal share of the
  // layer (see computeInternalWeightPct in PortfolioStockRow) instead of
  // every Core card showing this same coreWeightPct (the layer's share of
  // the WHOLE portfolio) like the old bug did.
  const coreLayerTotalValue = computeLayerTotalValue(coreStocks);
  const satelliteLayerTotalValue = computeLayerTotalValue(satelliteStocks);
  const qualityLayerTotalValue = computeLayerTotalValue(qualityStocks);
  const coreWeightPct = computeLayerWeightPct(coreStocks, totalPortfolioValue);
  const satelliteWeightPct = computeLayerWeightPct(satelliteStocks, totalPortfolioValue);
  const qualityWeightPct = computeLayerWeightPct(qualityStocks, totalPortfolioValue);

  const allSections: PortfolioListSection[] = [
    {
      title: buildSectionTitle(t, 'Core', coreStocks, coreWeightPct),
      category: 'Core',
      accentColor: colors.core,
      data: coreStocks,
      currentWeightPct: coreWeightPct,
      layerTotalValue: coreLayerTotalValue,
    },
    {
      title: buildSectionTitle(t, 'Satellite', satelliteStocks, satelliteWeightPct),
      category: 'Satellite',
      accentColor: colors.satellite,
      data: satelliteStocks,
      currentWeightPct: satelliteWeightPct,
      layerTotalValue: satelliteLayerTotalValue,
    },
    {
      title: buildSectionTitle(t, 'Quality', qualityStocks, qualityWeightPct),
      category: 'Quality',
      accentColor: colors.quality,
      data: qualityStocks,
      currentWeightPct: qualityWeightPct,
      layerTotalValue: qualityLayerTotalValue,
    },
  ];
  const visibleSections = allSections.filter(
    (section) => activeFilter === 'All' || activeFilter === section.category,
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <StatusBar style={isDarkMode ? 'light' : 'dark'} />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('portfolio')}</Text>
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
          {/* LANGUAGE TOGGLE BUTTON UI: a text-based button showing the
              CURRENT active language ("HEB"/"EN"), replacing the earlier
              Globe icon — pressing it opens the same dropdown as before to
              pick the other one. The language itself lives in
              LanguageContext, shared app-wide, so this takes effect on both
              tabs immediately, with no navigation/refocus or app restart
              needed (unlike RN's own I18nManager RTL flip, which requires a
              reload). */}
          <TouchableOpacity
            style={styles.languageToggleButton}
            onPress={() => setIsLanguageMenuVisible(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={language === 'he' ? 'שנה שפה' : 'Change language'}>
            <Text style={styles.languageToggleButtonText}>{language === 'he' ? 'HEB' : 'EN'}</Text>
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
              {filterOptionLabel(t, filterOption)}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* STATE PROTECTION: a subtle, non-blocking banner — never a
          cleared list, never a blocking Alert — shown whenever the most
          recent sync attempt (initial load, pull-to-refresh, or an
          AppState-triggered background resync) couldn't actually reach
          the server. Whatever was already on screen (or, on a cold start
          that never got that far, an empty list) is left exactly as-is;
          this is purely informational, and disappears the moment any
          later sync actually succeeds. */}
      {syncWarning && (
        <View style={styles.syncWarningBanner}>
          <Text style={styles.syncWarningBannerText}>{t('syncFailedWarning')}</Text>
        </View>
      )}

      {isInitializing ? (
        <View style={styles.initializingContainer}>
          <PullToRefreshLogo isRefreshing overlay={false} />
          <Text style={styles.initializingText}>{t('loadingPortfolio')}</Text>
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

      {/* Liquidation toast (see showToast). pointerEvents="none" so it can
          never block a tap on the list or the add button underneath. */}
      {toastMessage !== null && (
        <Animated.View pointerEvents="none" style={[styles.toast, { opacity: toastOpacity }]}>
          <Text style={styles.toastText}>{toastMessage}</Text>
        </Animated.View>
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
              <Text style={styles.menuItemText}>{t('copyPortfolioData')}</Text>
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
                <Text style={styles.menuItemText}>{t('copyAllData')}</Text>
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
                <Text style={styles.menuItemText}>{t('exportBackupJson')}</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setIsMenuVisible(false);
                setIsImportModalVisible(true);
              }}>
              <Text style={styles.menuItemText}>{t('importBackupJson')}</Text>
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
              <Text style={styles.menuItemText}>{t('intelOnDemand')}</Text>
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
                  <Text style={styles.addModalTitle}>{t('addAsset')}</Text>
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
                  {/* ADD ASSET MODAL LAYOUT FIX: the ticker input now gets
                      its OWN full-width row (its autocomplete dropdown
                      shows "SYMBOL - Company Name (Exchange)", which needs
                      real room to be readable while typing) instead of
                      splitting a row 50/50 with the units field, which
                      used to squeeze it down to roughly half-width for no
                      good reason — units/total value don't need nearly as
                      much space as a ticker name does. */}
                  <View style={styles.tickerRow}>
                    <TickerAutocomplete
                      value={ticker}
                      onChangeText={setTicker}
                      onSelectTicker={setTicker}
                      onSubmit={handleAddTicker}
                      editable={!isAdding}
                    />
                  </View>

                  {/* Units and the optional Total Value now share their OWN
                      smaller row (flex: 1 each — see unitsInput's style),
                      no longer competing with the ticker input for space.
                      TEXT INPUT WIDTH FIX: flex: 1 + minWidth: '45%' (not a
                      fixed pixel width) so a large unit count like 11347 is
                      never truncated — maxLength=15 is a generous ceiling,
                      not a practical limit for any real position size. */}
                  <View style={styles.unitsValueRow}>
                    <TextInput
                      style={styles.unitsInput}
                      value={units}
                      onChangeText={setUnits}
                      placeholder={t('unitsPlaceholder')}
                      placeholderTextColor={colors.textSecondary}
                      keyboardType="numeric"
                      maxLength={15}
                      editable={!isAdding}
                    />
                    {/* AUTO-CALIBRATION FOR BROKEN PRICES: optional — see
                        handleAddTicker for how a value here becomes a
                        calibrationFactor. */}
                    <TextInput
                      style={styles.unitsInput}
                      value={totalValueInput}
                      onChangeText={setTotalValueInput}
                      placeholder={t('totalValueInBank')}
                      placeholderTextColor={colors.textSecondary}
                      keyboardType="numeric"
                      maxLength={15}
                      editable={!isAdding}
                    />
                  </View>

                  <Text style={styles.modalSectionLabel}>{t('category')}</Text>
                  <View style={styles.categoryRow}>
                    <TouchableOpacity
                      style={[
                        styles.categoryButton,
                        { borderColor: colors.core },
                        selectedCategory === 'Core' && { backgroundColor: colors.core },
                      ]}
                      onPress={() => setSelectedCategory('Core')}>
                      <Text style={styles.categoryButtonText}>{categoryLabel(t, 'Core')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.categoryButton,
                        { borderColor: colors.satellite },
                        selectedCategory === 'Satellite' && { backgroundColor: colors.satellite },
                      ]}
                      onPress={() => setSelectedCategory('Satellite')}>
                      <Text style={styles.categoryButtonText}>{categoryLabel(t, 'Satellite')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.categoryButton,
                        { borderColor: colors.quality },
                        selectedCategory === 'Quality' && { backgroundColor: colors.quality },
                      ]}
                      onPress={() => setSelectedCategory('Quality')}>
                      <Text style={styles.categoryButtonText}>{categoryLabel(t, 'Quality')}</Text>
                    </TouchableOpacity>
                  </View>

                  {/* QUALITY Z-SCORE MODULE: only shown once Quality is
                      selected above — ROIC is meaningless to the Trailing
                      Stop/Kill Switch mechanisms the other two layers use.
                      Optional; see handleAddTicker for how a blank value
                      here becomes a null roic. */}
                  {selectedCategory === 'Quality' && (
                    <TextInput
                      style={[styles.unitsInput, styles.standaloneInput]}
                      value={roicInput}
                      onChangeText={setRoicInput}
                      placeholder={t('roicPlaceholder')}
                      placeholderTextColor={colors.textSecondary}
                      keyboardType="numeric"
                      maxLength={15}
                      editable={!isAdding}
                    />
                  )}

                  {/* CORE LAYER INTERNAL ALLOCATION: only shown once Core
                      is selected above — an internal target is meaningless
                      to the Trailing Stop/Kill Switch mechanisms the other
                      two layers use. Optional; see handleAddTicker for how
                      a blank value here becomes a null internalTargetPct. */}
                  {selectedCategory === 'Core' && (
                    <TextInput
                      style={[styles.unitsInput, styles.standaloneInput]}
                      value={internalTargetInput}
                      onChangeText={setInternalTargetInput}
                      placeholder={t('internalTargetPlaceholder')}
                      placeholderTextColor={colors.textSecondary}
                      keyboardType="numeric"
                      maxLength={15}
                      editable={!isAdding}
                    />
                  )}

                  <Text style={styles.modalSectionLabel}>{t('assetType')}</Text>
                  <View style={styles.assetTypeRow}>
                    <TouchableOpacity
                      style={[
                        styles.assetTypeButton,
                        { borderColor: colors.bullish },
                        selectedAssetType === 'Stock' && { backgroundColor: colors.bullish },
                      ]}
                      onPress={() => setSelectedAssetType('Stock')}>
                      <Text style={styles.assetTypeButtonText}>{assetTypeLabel(t, 'Stock')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.assetTypeButton,
                        { borderColor: colors.core },
                        selectedAssetType === 'ETF' && { backgroundColor: colors.core },
                      ]}
                      onPress={() => setSelectedAssetType('ETF')}>
                      <Text style={styles.assetTypeButtonText}>{assetTypeLabel(t, 'ETF')}</Text>
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
                        <Text style={styles.addButtonText}>{t('addToPortfolio')}</Text>
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
                <Text style={styles.addModalTitle}>{t('importBackupTitle')}</Text>
                <TouchableOpacity
                  onPress={() => setIsImportModalVisible(false)}
                  disabled={isRestoring}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="סגור">
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>

              <Text style={styles.modalSectionLabel}>{t('pasteBackupJsonLabel')}</Text>
              <TextInput
                style={styles.importTextArea}
                value={importText}
                onChangeText={setImportText}
                placeholder={t('pasteBackupPlaceholder')}
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
                    <Text style={styles.addButtonText}>{t('restore')}</Text>
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

              <Text style={[styles.addModalTitle, styles.intelModalTitle]}>{t('intelOnDemand')}</Text>

              <Text style={styles.modalSectionLabel}>{t('tickersCommaSeparatedLabel')}</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.intelTextInput}
                  value={intelInput}
                  onChangeText={setIntelInput}
                  placeholder={t('tickersPlaceholderExample')}
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
                    <Text style={styles.addButtonText}>{t('fetchIntel')}</Text>
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
                        <Text style={styles.intelErrorText}>
                          {t('errorPrefix')}: {entry.error}
                        </Text>
                      ) : entry.news.length === 0 ? (
                        <Text style={styles.intelEmptyText}>
                          {t('noNewsForTicker', { ticker: entry.ticker })}
                        </Text>
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
                                  {(article.tag || t('criticalAlertTag')) + '  '}
                                </Text>
                              )}
                              {article.title}
                            </Text>
                            {article.link ? (
                              <TouchableOpacity
                                onPress={() => handleOpenArticleLink(article.link)}
                                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                                <Text style={styles.intelLinkButtonText}>{t('readFullArticle')}</Text>
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
                    <Text style={styles.addButtonText}>{t('copyIntel')}</Text>
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
  // CORE LAYER INTERNAL ALLOCATION FIX: this layer's own total market
  // value, computed once in PortfolioScreen (see computeLayerTotalValue)
  // and passed down — the denominator this row needs to compute ITS OWN
  // share of the layer via computeInternalWeightPct. Replaces the old
  // currentWeightPct prop (that layer's share of the WHOLE portfolio,
  // identical for every card in the section) that used to be shown here
  // by mistake — see the Core JSX block's own comment. currentWeightPct
  // itself lives on PortfolioListSection still, for the section HEADER,
  // which legitimately does want the layer's whole-portfolio share.
  layerTotalValue: number;
  // Receives the whole position, not just its ticker: the delete handler
  // needs its category (does it move to the Ambush Radar?) and its quote
  // data (the Ambush row it hands over).
  onDelete: (stock: PortfolioStock) => void;
  onSaveEdit: (
    ticker: string,
    units: number,
    assetType: AssetType,
    totalValueInput: string,
    roicInput: string,
    internalTargetInput: string,
  ) => void;
  colors: PipelineColorScheme;
  styles: PortfolioStyles;
  language: Language;
  t: TFunction;
};

// Wrapped in memo() so updating one position (price refresh, edit, delete)
// doesn't re-render every other row in the SectionList — stocks state
// updates already keep unaffected PortfolioStock objects referentially
// stable (see onRefresh/handleSaveEdit/handleDeleteTicker above), and
// accentColor/layerTotalValue/onDelete/onSaveEdit/colors/styles/language/t
// are all stable across renders too (a fixed per-theme accent color, a
// number that only changes when the layer's actual composition changes,
// useCallback-wrapped handlers, the parent's own useMemo-derived theme
// values, and the language string/translator function respectively —
// colors/styles only actually change reference on a real theme toggle,
// language/t only on a real language switch), so
// this comparison is meaningful, not a no-op. memo() only shallow-compares
// props, not context, but this component reads no context of its own —
// colors/styles/language/t arrive as props from PortfolioScreen, which is
// what actually re-renders on a theme or language change and passes the
// new values down.
const PortfolioStockRow = memo(function PortfolioStockRow({
  stock,
  accentColor,
  layerTotalValue,
  onDelete,
  onSaveEdit,
  colors,
  styles,
  language,
  t,
}: PortfolioStockRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [unitsText, setUnitsText] = useState(String(stock.units));
  const [editedAssetType, setEditedAssetType] = useState<AssetType>(stock.assetType);
  // AUTO-CALIBRATION FOR BROKEN PRICES: deliberately starts (and resets on
  // every re-entry into edit mode, see handleStartEditing) BLANK rather
  // than pre-filled with today's computed total — see onSaveEdit in
  // PortfolioScreen for why: a blank field here means "leave this
  // position's existing calibration alone," which would break if it were
  // pre-filled with a value that then got silently resubmitted alongside
  // an unrelated units change.
  const [totalValueText, setTotalValueText] = useState('');
  // QUALITY Z-SCORE MODULE: same "starts blank, means leave unchanged"
  // pattern as totalValueText above — see onSaveEdit in PortfolioScreen.
  const [roicText, setRoicText] = useState('');
  // CORE LAYER INTERNAL ALLOCATION: same "starts blank, means leave
  // unchanged" pattern as roicText above.
  const [internalTargetText, setInternalTargetText] = useState('');

  // TASE ETF MATH FIX (Nominal Value / Erech Nakuv): a TASE ETF's raw
  // `units` is a Nominal Value quantity — 100 nominal units = 1 real
  // pricing unit — so BOTH this row's own local total AND
  // PortfolioScreen's USD layer/portfolio totals (see allSections /
  // buildSectionTitle) go through getEffectiveUnits first. The raw
  // `stock.units` the user actually entered is still what's shown in the
  // quantity row itself below — only the VALUE math changes.
  const effectiveUnits = getEffectiveUnits(stock.ticker, stock.assetType, stock.units);

  // MULTI-CURRENCY DISPLAY: this row's own total, shown in the
  // instrument's own local currency (self-consistent — it's all one
  // instrument, so there's no cross-currency mixing risk here). This is
  // NEVER used for portfolio-wide totals/allocation math — that's computed
  // independently in PortfolioScreen from `stock.price` (USD) alone; see
  // the IMPORTANT note above allSections there.
  const localTotalValue = effectiveUnits * stock.localPrice;

  // CORE LAYER INTERNAL ALLOCATION FIX: (Asset Total Value / Layer Total
  // Value) * 100 — this asset's own share of ITS layer, as opposed to
  // currentWeightPct (that layer's share of the whole portfolio). Uses
  // `stock.price` (USD), the same basis computeLayerTotalValue itself
  // used to build layerTotalValue, never localPrice — see the IMPORTANT
  // multi-currency note on allSections in PortfolioScreen for why mixing
  // those would silently corrupt this for any mixed-currency layer.
  // Computed for every category (harmless — same reasoning as
  // highestWatermark/roic being tracked regardless of category), but only
  // actually rendered for Core today (see the JSX below).
  const internalWeightPct = computeInternalWeightPct(stock, layerTotalValue);

  // TASE AGOROT DISPLAY: the UNIT price, Agorot-formatted for a ".TA"
  // ticker (e.g. "3985 אג'") — the position TOTAL above/below always stays
  // in whole Shekels regardless (see formatTotalValue), matching how
  // Israeli banks quote unit prices vs. position values differently.
  const agorotSuffix = t('ag');
  const unitPriceDisplay = formatUnitPrice(stock.ticker, stock.localPrice, stock.currencySymbol, agorotSuffix);

  // DATA-LOSS FIX: this position's price fetch failed. It stays in the list
  // (so storage stays complete), but its price fields are placeholders, so
  // the row shows "N/A" for the total and hides every price-derived signal
  // below. A placeholder price of 0 would otherwise read as a triggered
  // trailing stop or a -100% drop.
  const isPriceUnavailable = stock.priceStatus === 'unavailable';
  const totalValueDisplay = isPriceUnavailable
    ? t('notAvailable')
    : formatTotalValue(localTotalValue, stock.currencySymbol);

  // LAYER 1: SATELLITE — Trailing Stop Reversion: a single hard 12% for
  // EVERY Satellite position, Stock or ETF alike (the old ETF-specific 7%
  // exception is gone — see SATELLITE_TS_PCT in thresholds.ts). Core
  // positions are held through drawdowns and Quality gets the Fundamental
  // Audit Kill Switch below instead, so neither ever computes a TS price —
  // enforced by a hardcoded architectural guard, not just this component's
  // own JSX gate (see computeSatelliteTrailingStopPrice's own comment).
  const trailingStopPrice = computeSatelliteTrailingStopPrice(stock.category, stock.highestWatermark);
  // Red/green, not just a triggered/untriggered binary: colors.bearish
  // once price has fallen to (or through) the trigger, colors.bullish while
  // it's still safely above it — see trailingStopPriceColor at the JSX
  // call site.
  const isTrailingStopTriggered = trailingStopPrice !== null && stock.price <= trailingStopPrice;

  // SATELLITE CARD FIX (HWM vs. Drawdown): the card used to show
  // stock.drawdownPct here (distance from the 52-WEEK HIGH) under a "Drop"
  // label — a different, and often confusingly different, number from the
  // trailing stop's own basis. The 12% trailing stop is computed off
  // highestWatermark (see computeSatelliteTrailingStopPrice above), NOT
  // off the 52-week high, and the two can diverge in either direction: a
  // position added well below its 52-week high starts tracking its OWN
  // watermark from the price it was added at, so "how far below the
  // 52-week high" tells the user nothing about how close price actually
  // is to triggering a sell. hwmDropPct is that missing number — the
  // percentage drop from THIS position's own watermark to its current
  // price — computed on the exact same USD basis trailingStopPrice
  // already uses, so the two are always directly comparable (e.g. a
  // trailing stop at -12% and hwmDropPct reading -9% both being measured
  // from the same watermark makes it obvious why the stop hasn't fired
  // yet).
  const hwmDropPct =
    stock.highestWatermark !== null && stock.highestWatermark > 0
      ? ((stock.price - stock.highestWatermark) / stock.highestWatermark) * 100
      : null;

  // SMA200 MODIFICATION (Satellite only): read-only macro-context display —
  // no Bullish/Bearish color coding, no SMA50 at all (INDICATOR PURGE — see
  // the JSX below, which renders this as plain gray text, never a colored
  // trend badge). USD-normalized stock.sma200 is scaled onto localPrice's
  // basis first (exact, not an approximation — see deriveLocalValue), same
  // as every other Agorot-aware price display in this file.
  const localSma200 =
    stock.category === 'Satellite' && stock.sma200 !== null
      ? deriveLocalValue(stock.sma200, stock.localPrice, stock.price)
      : null;
  const sma200Display =
    localSma200 !== null ? formatUnitPrice(stock.ticker, localSma200, stock.currencySymbol, agorotSuffix) : null;

  // LAYER 2: QUALITY — Kill Switch Tracker: a position that has fallen 15%+
  // from its 52-week high gets flagged RED with a Fundamental Audit tag,
  // otherwise it reads HOLD. This is the drawdown-based half of "quality_
  // status === 'FUNDAMENTAL_AUDIT_REQUIRED' (or drawdown <= -15%)" — the
  // quality_status API field doesn't exist on the live backend yet (only in
  // the unexecuted Supabase view — see backend/sql/001_ui_pipeline_metrics.
  // sql), so this reads the one half of that condition that IS real,
  // already-delivered data: stock.drawdownPct.
  const isFundamentalAuditRequired =
    stock.category === 'Quality' && stock.drawdownPct !== null && stock.drawdownPct <= -15;

  // LAYER 2: QUALITY — Z-Score Module: the alert boolean (stock.
  // qualityZScoreAlert) already reflects the backend's own roic >= 15% AND
  // Quality-layer-weight <= 10% gate (see backend/main.py's
  // QUALITY_ZSCORE_* constants) — never re-derived here. This additionally
  // hardcodes a `stock.category === 'Quality'` check before it's ever
  // allowed to show, same defense-in-depth reasoning as
  // computeSatelliteTrailingStopPrice above: a stray/mis-set value on a
  // non-Quality stock (shouldn't happen — the backend only evaluates this
  // for Quality requests — but this is the belt-and-suspenders layer) can
  // never surface an alert on the wrong layer.
  const isQualityZScoreAlertActive = stock.category === 'Quality' && stock.qualityZScoreAlert === true;

  const handleStartEditing = () => {
    setUnitsText(String(stock.units));
    setEditedAssetType(stock.assetType);
    setTotalValueText('');
    setRoicText('');
    setInternalTargetText('');
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    const parsedUnits = Number(unitsText);
    if (!Number.isFinite(parsedUnits) || parsedUnits <= 0) {
      Alert.alert(t('invalidUnitsTitle'), t('invalidUnitsMessage'));
      return;
    }
    onSaveEdit(stock.ticker, parsedUnits, editedAssetType, totalValueText, roicText, internalTargetText);
    setIsEditing(false);
  };

  return (
    <View style={styles.stockCard}>
      <View style={styles.stockTopRow}>
        <Text style={styles.stockTicker}>{stock.ticker}</Text>
        <View style={styles.stockTopRight}>
          <View style={styles.assetTypeBadge}>
            <Text style={styles.assetTypeBadgeText}>{assetTypeLabel(t, stock.assetType)}</Text>
          </View>
          <View style={[styles.categoryBadge, { backgroundColor: accentColor }]}>
            <Text style={styles.categoryBadgeText}>{categoryLabel(t, stock.category)}</Text>
          </View>
          <TouchableOpacity
            onPress={() => onDelete(stock)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={`הסר את ${stock.ticker} מהתיק`}>
            <Text style={styles.deleteButtonText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      {isEditing ? (
        <View style={styles.editContainer}>
          <View style={styles.unitsEditRow}>
            {/* TEXT INPUT WIDTH FIX: flex: 1 + minWidth: '45%' (see
                unitsEditInput's style) so a large unit count like 11347 is
                never truncated by a fixed pixel width. */}
            <TextInput
              style={styles.unitsEditInput}
              value={unitsText}
              onChangeText={setUnitsText}
              keyboardType="numeric"
              maxLength={15}
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
          {/* AUTO-CALIBRATION FOR BROKEN PRICES: optional — see onSaveEdit
              in PortfolioScreen for how a value here recalibrates this
              position. Left blank (the default every time editing starts —
              see handleStartEditing), the existing calibration (if any) is
              preserved unchanged. Same width fix as the units field above. */}
          <TextInput
            style={[styles.unitsEditInput, styles.totalValueEditInput]}
            value={totalValueText}
            onChangeText={setTotalValueText}
            placeholder={t('totalValueInBank')}
            placeholderTextColor={colors.textSecondary}
            keyboardType="numeric"
            maxLength={15}
            onSubmitEditing={handleSaveEdit}
          />
          {/* QUALITY Z-SCORE MODULE: only shown for Quality positions —
              ROIC is meaningless to the Trailing Stop/Kill Switch
              mechanisms the other two layers use. Same "blank preserves
              the existing value" pattern as the Total Value field above. */}
          {stock.category === 'Quality' && (
            <TextInput
              style={[styles.unitsEditInput, styles.totalValueEditInput]}
              value={roicText}
              onChangeText={setRoicText}
              placeholder={t('roicPlaceholder')}
              placeholderTextColor={colors.textSecondary}
              keyboardType="numeric"
              maxLength={15}
              onSubmitEditing={handleSaveEdit}
            />
          )}
          {/* CORE LAYER INTERNAL ALLOCATION: only shown for Core positions
              — an internal target is meaningless to the Trailing Stop/Kill
              Switch mechanisms the other two layers use. Same "blank
              preserves the existing value" pattern as the Total Value/ROIC
              fields above. */}
          {stock.category === 'Core' && (
            <TextInput
              style={[styles.unitsEditInput, styles.totalValueEditInput]}
              value={internalTargetText}
              onChangeText={setInternalTargetText}
              placeholder={t('internalTargetPlaceholder')}
              placeholderTextColor={colors.textSecondary}
              keyboardType="numeric"
              maxLength={15}
              onSubmitEditing={handleSaveEdit}
            />
          )}
          <View style={styles.editAssetTypeRow}>
            <TouchableOpacity
              style={[
                styles.editAssetTypeButton,
                { borderColor: colors.bullish },
                editedAssetType === 'Stock' && { backgroundColor: colors.bullish },
              ]}
              onPress={() => setEditedAssetType('Stock')}>
              <Text style={styles.editAssetTypeButtonText}>{assetTypeLabel(t, 'Stock')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.editAssetTypeButton,
                { borderColor: colors.core },
                editedAssetType === 'ETF' && { backgroundColor: colors.core },
              ]}
              onPress={() => setEditedAssetType('ETF')}>
              <Text style={styles.editAssetTypeButtonText}>{assetTypeLabel(t, 'ETF')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.stockBottomRow}>
          <View style={styles.unitsDisplayRow}>
            {/* STRICT RTL/LTR TEXT SEPARATION: this used to be one
                interpolated string starting with a number ("1436 יח'
                ב-₪39.85"), which the bidi rendering engine reverses — a
                number-first run inside an RTL-aligned Text confuses it in a
                way a word-first string doesn't. Split into three
                independent <Text> nodes instead — the units count+word, the
                translated "at" word, and the price value — laid out by an
                explicit row/row-reverse View so each language's natural
                reading order (and its own phrasing, via t()) determines the
                visual order directly, rather than relying on bidi to sort
                out a single mixed-content string.
                TASE AGOROT DISPLAY: unitPriceDisplay reads e.g. "3985 אג'"
                instead of "₪39.85" for a ".TA" ticker — see
                formatUnitPrice above. Note this row still shows the RAW
                `stock.units` the user entered/holds (Nominal Value, for a
                TASE ETF) — only the VALUE math (totalValueDisplay) uses
                effectiveUnits; see the TASE ETF MATH FIX note above. */}
            {/* DATA-LOSS FIX: an 'unavailable' row still shows the units
                actually held (those are real, persisted data), but no
                "@ price". "Price unavailable" is translated text, so it
                gets its own language-aligned Text node rather than the
                LTR-only value style. */}
            <View style={styles.unitsPriceRow}>
              <Text style={styles.stockDetailText}>{formatUnitsLabel(t, stock.units)}</Text>
              {isPriceUnavailable ? (
                <Text style={styles.priceUnavailableText}>{t('priceUnavailable')}</Text>
              ) : (
                <>
                  <Text style={styles.stockDetailText}>{t('atPrice')}</Text>
                  <Text style={styles.stockDetailValueText}>{unitPriceDisplay}</Text>
                </>
              )}
            </View>
            {/* EDIT ICON HITBOX FIX: this used to be a bare 14px icon with
                only hitSlop padding the touch target — on a real device
                that region sits close enough to stockTotalValue (the price
                Text, a sibling laid out at the opposite end of
                stockBottomRow via justifyContent: 'space-between') that
                taps near the icon's edge could be swallowed by whichever
                sibling's layout box happened to extend furthest, without
                the icon's own box being visually distinguishable. Now:
                (1) real padding (styles.editIconTouchable) grows the
                ACTUAL layout box, not just the invisible hitSlop region,
                so the touchable has real size to stack correctly against
                its neighbors; (2) zIndex lifts it above any sibling text
                so it always wins hit-testing on overlap; (3) hitSlop is
                widened further on top of both. */}
            <TouchableOpacity
              onPress={handleStartEditing}
              style={styles.editIconTouchable}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
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

      {/* INDICATOR PURGE — each layer shows ONLY what its own protocol
          calls for; nothing here is shared across layers any more (no
          MomentumBar/TrendBadges — those stay Ambush-Radar-only, see
          StockCard.tsx). All three blocks are gated on !isEditing, same as
          the rest of this row's live-data display, and on a live price:
          their inputs are only placeholders while isPriceUnavailable. */}

      {/* DATA-LOSS FIX: shown in place of the layer signals below when this
          position's price fetch failed. The position itself is safe in
          storage; pulling to refresh retries the fetch. */}
      {!isEditing && isPriceUnavailable && (
        <Text style={styles.priceFetchFailedHint}>{t('priceFetchFailedHint')}</Text>
      )}

      {/* LAYER 1: SATELLITE — SMA200 read-only, grayed out, no color
          coding ("macro-context only" — SMA50 is not shown at all, per the
          Indicator Purge), the High Water Mark itself, the precise TS
          trigger price in red/green based on current price, and the drop
          from THAT watermark (not the 52-week high — see hwmDropPct's own
          comment for why those are different numbers and why this one is
          the one that actually explains the trailing stop's state). */}
      {!isEditing && !isPriceUnavailable && stock.category === 'Satellite' && (
        <>
          {sma200Display !== null && (
            <Text style={styles.macroContextText}>
              {t('sma200')}: {sma200Display}
            </Text>
          )}

          {/* SATELLITE CARD FIX: the High Water Mark itself, explicitly
              labeled — previously never shown at all, only its DERIVED
              trailing-stop price was. Same USD-basis reasoning as
              trailingStopPrice just below (highestWatermark is tracked in
              USD regardless of the instrument's own trading currency). */}
          {stock.highestWatermark !== null && (
            <Text style={styles.macroContextText}>
              {t('highWaterMark')}: ${stock.highestWatermark.toFixed(2)}
            </Text>
          )}

          {trailingStopPrice !== null && (
            // Trailing Stop is a computed USD threshold (highestWatermark
            // is tracked in USD — see computeHighestWatermark above), not
            // a raw quoted price, so it stays displayed in USD ('$')
            // regardless of the instrument's own trading currency —
            // converting a derived threshold back to local currency isn't
            // something the frontend can do without re-deriving the FX
            // rate itself.
            <Text
              style={[
                styles.trailingStopText,
                isTrailingStopTriggered ? styles.trailingStopBearishText : styles.trailingStopBullishText,
              ]}>
              {isTrailingStopTriggered ? '⚠ ' : ''}
              {t('trailingStopActivatedAt')}: ${trailingStopPrice.toFixed(2)}
            </Text>
          )}

          {/* SATELLITE CARD FIX: replaces the old stock.drawdownPct-based
              "Drop" line (distance from the 52-week HIGH, a different
              basis than the trailing stop itself uses) with the drop from
              THIS position's own High Water Mark — see hwmDropPct's own
              comment above for why that's the number that actually
              explains "why hasn't the 12% trailing stop triggered yet." */}
          {hwmDropPct !== null && (
            <Text style={styles.drawdownText}>
              {t('dropFromHwm')}: {hwmDropPct.toFixed(2)}%
            </Text>
          )}

          {/* PROTECTION STATE TRACKER: the exact manual Stop-Loss order
              parameters for this position, rendered EXCLUSIVELY for
              Satellite assets — see SatelliteProtectionCard's own
              "INTEGRATION NOTE" for why it carries no card chrome of its
              own (it's embedded directly below this card's own metrics
              above, not a separate list item). currentPrice is this
              row's live, already-calibrated/USD-normalized stock.price —
              the same basis trailingStopPrice/hwmDropPct above already
              use. hwm is this position's own highestWatermark (the
              "database" High Water Mark this feature is specified
              against); gated on it being non-null for the same reason
              trailingStopPrice/sma200Display above are — no watermark yet
              means no live price has been fetched for this position at
              all. */}
          {stock.highestWatermark !== null && (
            <SatelliteProtectionCard
              ticker={stock.ticker}
              currentPrice={stock.price}
              hwm={stock.highestWatermark}
            />
          )}
        </>
      )}

      {/* LAYER 2: QUALITY — Indicator Purge: no Trailing Stop, no SMA50,
          no SMA200 at all. Kill Switch Tracker: 52-Week Drawdown + a
          RED "[FUNDAMENTAL AUDIT REQUIRED]" block when triggered, else a
          neutral/green "[HOLD]". */}
      {!isEditing && !isPriceUnavailable && stock.category === 'Quality' && stock.drawdownPct !== null && (
        <View
          style={[
            styles.killSwitchBlock,
            isFundamentalAuditRequired && styles.killSwitchBlockAlert,
          ]}>
          <Text
            style={[
              styles.killSwitchDrawdownText,
              isFundamentalAuditRequired && styles.killSwitchDrawdownTextAlert,
            ]}>
            {t('drop')}: {stock.drawdownPct.toFixed(2)}%
          </Text>
          <Text
            style={[
              styles.killSwitchTag,
              isFundamentalAuditRequired ? styles.killSwitchTagAlert : styles.killSwitchTagHold,
            ]}>
            {isFundamentalAuditRequired ? `[${t('fundamentalAuditRequired')}]` : `[${t('hold')}]`}
          </Text>
        </View>
      )}

      {/* LAYER 2: QUALITY — Z-Score Module: a separate, independent signal
          from the Kill Switch block above (drawdown vs. 52-week high) — a
          statistical read of price vs. SMA50, not a fundamental drawdown
          review. The score itself renders whenever the backend could
          compute one; the ALERT tag only when isQualityZScoreAlertActive
          (the backend's own roic >= 15% AND Quality-layer-weight <= 10%
          gate, plus this component's own hardcoded category check — see
          its own comment above). Independent of stock.drawdownPct's
          nullity so it still shows even in the rare case the Kill Switch
          block above doesn't (e.g. a missing 52-week high). */}
      {!isEditing && !isPriceUnavailable && stock.category === 'Quality' && stock.qualityZScore !== null && (
        <View style={styles.zScoreBlock}>
          <Text style={styles.zScoreText}>
            {t('qualityZScore')}: {stock.qualityZScore.toFixed(2)}
          </Text>
          {isQualityZScoreAlertActive && (
            <Text style={styles.zScoreAlertTag}>{`[${t('zScoreAlert')}]`}</Text>
          )}
        </View>
      )}

      {/* LAYER 3: CORE — Indicator Purge: no TS, no SMAs, no Drawdown.
          CORE LAYER INTERNAL ALLOCATION FIX: this used to show
          currentWeightPct — this layer's live share of the WHOLE
          portfolio (e.g. "68%"), IDENTICAL on every single Core card,
          against the fixed Fortress 2.0 layer-level target
          (CATEGORY_TARGET_PCT.Core, also identical on every card) — never
          telling a user how their Core holdings are balanced against EACH
          OTHER. Now shows internalWeightPct — THIS asset's own share of
          Core's total value (computeInternalWeightPct) — against an
          OPTIONAL, per-asset internalTargetPct the user can define for
          this specific holding (see the Add/Edit forms' "Internal Target"
          field), since there's no fixed model for sub-asset targets the
          way there is at the layer level. No target shown at all when the
          user hasn't set one, rather than fabricating one. No dividend
          yield/cash-flow placeholder rendered — that data doesn't exist
          anywhere in this app's pipeline yet, and a fabricated placeholder
          would violate "no placeholders" more than simply omitting it. */}
      {!isEditing && !isPriceUnavailable && stock.category === 'Core' && (
        <Text style={styles.allocationText}>
          {t('internalAllocation')}: {internalWeightPct.toFixed(1)}%
          {stock.internalTargetPct !== null &&
            ` / ${t('target')}: ${stock.internalTargetPct.toFixed(1)}%`}
        </Text>
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
  // ROBUST LANGUAGE CONTEXT: styles for every element that now renders
  // translated (t()) text switch alignment/writingDirection with the
  // language; elements whose text is still Hebrew-only regardless of the
  // toggle (out of this pass's translation scope — see PortfolioScreen's
  // top-level comments) deliberately keep their literal 'right'/'rtl'.
  const isHebrew = language === 'he';

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
    // RTL/LTR LOCALIZATION: right-aligned in Hebrew, left-aligned in
    // English; numeric values/ticker symbols elsewhere are deliberately
    // left at their default (LTR) alignment regardless (see StockCard.tsx).
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '700',
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  // LANGUAGE TOGGLE BUTTON UI: a small bordered pill showing "HEB"/"EN" —
  // replaces the earlier Globe icon so the CURRENT language is visible at a
  // glance, not just implied by an icon.
  languageToggleButton: {
    borderWidth: 1.5,
    borderColor: colors.textSecondary,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  languageToggleButtonText: {
    // A language CODE, not translatable text — always LTR/centered
    // regardless of the active language, same reasoning as ticker symbols
    // elsewhere in this app.
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 8,
    zIndex: 10,
  },
  // ADD ASSET MODAL LAYOUT FIX: the ticker input gets its own full-width
  // row — a plain block-level View (no flexDirection: 'row' siblings), so
  // TickerAutocomplete's own flex: 1 container fills the entire row width,
  // giving its "SYMBOL - Company Name (Exchange)" autocomplete dropdown
  // (and the typed ticker itself) genuine room to be readable. zIndex
  // matches the old shared inputRow's, so the dropdown still renders above
  // the units/total-value row below it.
  tickerRow: {
    marginBottom: 16,
    zIndex: 10,
  },
  // Units and the optional Total Value share a SMALLER second row, each
  // flex: 1 (see unitsInput below) — they don't need nearly as much space
  // as the ticker input above, which is exactly why splitting that row
  // 50/50 with them (the old layout) was the bug: it squeezed the ticker
  // down for two fields that don't need the room.
  unitsValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 8,
  },
  // TEXT INPUT WIDTH FIX: flex: 1 + minWidth: '45%' (not a fixed pixel
  // width, which was the actual bug — 70px truncates/can't fit a large
  // unit count like 11347) so both the units and Total Value fields (which
  // share this exact style, via unitsValueRow above) grow to a genuinely
  // usable width instead of being squeezed or clipped.
  unitsInput: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: colors.background,
    color: colors.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    textAlign: 'center',
  },
  // Shared by the ROIC field and the Internal Target field (Quality/Core
  // only, respectively) — both stand alone (not inside a unitsValueRow-
  // style flex row like units/totalValue above), so both need this same
  // bottom margin to match the spacing every other field in this form
  // already has.
  standaloneInput: {
    marginBottom: 16,
  },
  modalSectionLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 8,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  intelErrorText: {
    color: colors.warning,
    fontSize: 13,
    marginBottom: 12,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  intelEmptyText: {
    color: colors.textSecondary,
    fontSize: 13,
    marginBottom: 12,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
    // Shared by every "primary action" button in this file (Add to
    // Portfolio, Restore, Fetch Intel, Copy Intel) — all four now render
    // translated t() text, so it's safe for this one shared style to be
    // direction-aware.
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  filterScroll: {
    flexGrow: 0,
    marginBottom: 12,
  },
  filterRow: {
    paddingHorizontal: 16,
    gap: 8,
  },
  // STATE PROTECTION: a subtle, screen-level warning banner — same
  // warning/warningText color tokens as StockCard.tsx's own per-card
  // structural-stop banner, for visual consistency, but normal (not
  // negative) margins since this one sits at the screen level, not nested
  // inside a card.
  syncWarningBanner: {
    backgroundColor: colors.warning,
    marginHorizontal: 16,
    marginTop: 10,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  syncWarningBannerText: {
    color: colors.warningText,
    fontSize: 12,
    fontWeight: '700',
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
    // RTL/LTR: the full "<layer> (Target: X% | Actual: Y%) - N Assets"
    // string is translated-word-first with embedded LTR numeric runs
    // (percentages, the count) — the Unicode bidi algorithm places those
    // correctly within an aligned paragraph on its own (in either
    // direction), no per-token splitting needed — see buildSectionTitle.
    fontSize: 16,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 10,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
  // DATA-LOSS FIX fallbacks for a position whose price fetch failed: the
  // amber warning color marks the missing price, while the hint stays in
  // muted secondary text because nothing is wrong with the position itself.
  priceUnavailableText: {
    color: colors.warning,
    fontSize: 13,
    fontWeight: '600',
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  priceFetchFailedHint: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 6,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
  // EDIT ICON HITBOX FIX: see the TouchableOpacity's own comment at the
  // call site. Real padding (not just hitSlop) so the touchable's actual
  // layout box is bigger, plus a positive zIndex/elevation so it always
  // wins hit-testing over stockTotalValue (the price text) or any other
  // sibling it might visually sit close to.
  editIconTouchable: {
    padding: 8,
    zIndex: 10,
    elevation: 2,
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
  // TEXT INPUT WIDTH FIX: flex: 1 + minWidth: '45%' (was a fixed width: 56,
  // the same truncation bug as unitsInput above — a large unit count like
  // 11347 couldn't be typed/read at that width).
  unitsEditInput: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: colors.background,
    color: colors.textPrimary,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 13,
  },
  // AUTO-CALIBRATION FOR BROKEN PRICES: the inline edit form's "Total
  // Value in Bank" field — alone in its own row (see the JSX), so flex: 1
  // just fills the row's width; marginTop matches editContainer's own gap.
  totalValueEditInput: {
    marginTop: 0,
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
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  // LAYER 1: SATELLITE — SMA200's read-only "macro-context only" display:
  // deliberately always colors.textSecondary regardless of price/trend —
  // no bullish/bearish color coding, per the SMA200 Modification.
  macroContextText: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 6,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  trailingStopText: {
    // Translated-word-first label + LTR '$' threshold value — an aligned
    // paragraph, bidi handles the embedded number regardless of direction.
    // Base structural style only — color always comes from the bullish/
    // bearish variant below, applied at the call site.
    fontSize: 12,
    fontWeight: '700',
    marginTop: 6,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  // Trailing Stop Reversion: "the precise TS price trigger in red/green
  // based on current price" — always one or the other, not a neutral
  // default that only turns a warning color once triggered.
  trailingStopBullishText: {
    color: colors.bullish,
  },
  trailingStopBearishText: {
    color: colors.bearish,
  },
  drawdownText: {
    // Translated-word-first ("Drop: -X%"), same bidi-safety reasoning as
    // sectionTitle above — safe as one Text node.
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 6,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  // LAYER 2: QUALITY — Kill Switch Tracker. Alert (FUNDAMENTAL_AUDIT_
  // REQUIRED) is a loud, filled reviewAlert-red block; Hold is deliberately
  // quiet (no fill, just green text) — an "everything's fine" status
  // shouldn't compete visually with a real alert.
  killSwitchBlock: {
    marginTop: 8,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  killSwitchBlockAlert: {
    backgroundColor: colors.reviewAlert,
  },
  killSwitchDrawdownText: {
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  killSwitchDrawdownTextAlert: {
    color: colors.reviewAlertText,
  },
  killSwitchTag: {
    fontSize: 13,
    fontWeight: '800',
    marginTop: 4,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  killSwitchTagAlert: {
    color: colors.reviewAlertText,
  },
  killSwitchTagHold: {
    color: colors.bullish,
  },
  // LAYER 2: QUALITY — Z-Score Module. A quiet neutral block by default
  // (the raw score alone isn't itself alarming); the alert tag borrows the
  // same reviewAlert red as the Kill Switch's own alert state above, so
  // both of Quality's alert signals read consistently.
  zScoreBlock: {
    marginTop: 8,
  },
  zScoreText: {
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  zScoreAlertTag: {
    color: colors.reviewAlert,
    fontSize: 13,
    fontWeight: '800',
    marginTop: 2,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  // LAYER 3: CORE — Allocation Tracking. Translated-word-first
  // ("Allocation: X% / Target: 70%"), same bidi-safety reasoning as
  // sectionTitle above — safe as one Text node.
  allocationText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 6,
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
  },
  // Liquidation toast: a compact card floating above the add button (which
  // is 56px tall at bottom 24, so 96 clears it), themed with the card
  // background and primary text so it reads as a calm notice rather than a
  // warning.
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 96,
    backgroundColor: colors.cardBackground,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.satellite,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 6,
  },
  toastText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
    // Shared by the "More options" menu (fully translated) AND the
    // language dropdown's "English"/"עברית" rows — the latter are
    // deliberately shown in their OWN language's native script regardless
    // of the active app language (a standard language-picker convention;
    // see the LanguageContext/dropdown comments), so this direction switch
    // only actually changes alignment for that one short word, never its
    // script.
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
    // Shared by the Add Asset, Import Backup, and On-Demand Intel modal
    // titles — all three now render translated t() text, so it's safe for
    // this one shared style to be direction-aware.
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    textAlign: isHebrew ? 'right' : 'left',
    writingDirection: isHebrew ? 'rtl' : 'ltr',
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
