import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type SectionListData,
  type SectionListRenderItem,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';

import { PullToRefreshLogo } from '@/components/PullToRefreshLogo';
import { QualityAmbushCard } from '@/components/QualityAmbushCard';
import { StockCard } from '@/components/StockCard';
import { TickerAutocomplete } from '@/components/TickerAutocomplete';
import { DEMO_QUALITY_AMBUSH_ASSETS } from '@/constants/ambush-demo-data';
import { AMBUSH_ZONE_TITLE_KEY, ambushZoneColors } from '@/constants/ambush-zones';
import { assetTypeLabel } from '@/constants/labels';
import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { AMBUSH_TICKERS_STORAGE_KEY } from '@/constants/storage-keys';
import { STRUCTURAL_STOP_THRESHOLD } from '@/constants/thresholds';
import { usePipelineLanguage, type Language } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import { useAppForegroundRefresh } from '@/hooks/useAppForegroundRefresh';
import { createUnavailableQuote, fetchInChunks, fetchStockData, type StockQuote } from '@/services/api';
import type { AmbushAsset, AmbushTickerEntry, SatelliteAmbushAsset } from '@/types/ambush';
import type { AssetType } from '@/types/asset';
import { AMBUSH_READINESS_ORDER, groupAmbushByReadiness, type AmbushReadinessZone } from '@/utils/ambush-grouping';
import { loadAmbushTickerEntries, subscribeToAmbushAdditions } from '@/utils/ambush-storage';
import { sendStructuralStopNotification } from '@/utils/notifications';
import { formatAmbushLines } from '@/utils/report-formatters';
import { normalizeTickerInput } from '@/utils/ticker';

// Per-section data SectionList carries alongside each section's rows:
// which readiness zone it is, its translated title and accent color, the
// zone's full asset count (shown even while collapsed, when `data` is
// empty), and whether it's collapsed.
type AmbushSectionInfo = {
  key: AmbushReadinessZone;
  title: string;
  accentColor: string;
  count: number;
  isCollapsed: boolean;
};

type AmbushSection = SectionListData<AmbushAsset, AmbushSectionInfo>;

// Every section starts expanded.
const INITIAL_COLLAPSED_SECTIONS: Record<AmbushReadinessZone, boolean> = {
  valueZone: false,
  watch: false,
  invalidated: false,
};

// Keyed by layer AND ticker: the same ticker can be on the radar as both a
// Satellite and a Quality asset (the AAPL demo row alongside a watched
// AAPL, for instance), and React keys must be unique.
function extractAmbushItemKey(item: AmbushAsset): string {
  return `${item.layer}:${item.ticker}`;
}

const DEFAULT_ENTRIES: AmbushTickerEntry[] = [
  { ticker: 'AAPL', assetType: 'Stock' },
  { ticker: 'TSLA', assetType: 'Stock' },
];

// "Ambush Radar" (מכ"ם מארבים) tracks stocks and ETFs against their trend to
// surface mean-reversion opportunities: stocks are judged against SMA50,
// ETFs against the longer SMA200 (see StockCard for the trend rule itself).
export default function AmbushRadarScreen() {
  const { colors, isDarkMode } = usePipelineTheme();
  // ROBUST LANGUAGE CONTEXT: a plain context read, same as usePipelineTheme
  // above — switching languages re-renders this screen, and every child
  // that reads it (StockCard included), immediately, no app restart.
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, isDarkMode, language), [colors, isDarkMode, language]);

  // The real, persisted watchlist. Every row is a Satellite asset, tagged
  // `layer: 'Satellite'` when it is created (load, add, liquidation
  // handover) rather than at render time, so unchanged rows keep their
  // object identity and StockCard's memo() keeps working.
  const [stocks, setStocks] = useState<SatelliteAmbushAsset[]>([]);
  // CACHE INTEGRITY (AppState/hydration safety): see the identical
  // canPersistRef in PortfolioScreen (index.tsx) for the full rationale —
  // the short version is that the persistence effect below used to gate
  // purely on `!isInitializing`, which flips to false on every exit path
  // out of loadAmbushData, including the two bail-outs that deliberately
  // leave `stocks` untouched. That let a failed/interrupted load (e.g.
  // the OS suspending an in-flight fetch while this app was backgrounded
  // on Android) permanently overwrite the real, still-intact
  // AsyncStorage watchlist with an empty array the instant isInitializing
  // went false. canPersistRef starts false and is flipped true ONLY by
  // setStocksTrusted, which every call site with genuinely trustworthy
  // data already uses instead of calling setStocks directly.
  const canPersistRef = useRef(false);

  const setStocksTrusted = useCallback(
    (update: SatelliteAmbushAsset[] | ((previous: SatelliteAmbushAsset[]) => SatelliteAmbushAsset[])) => {
      canPersistRef.current = true;
      setStocks(update);
    },
    [],
  );

  // STATE PROTECTION: a subtle, non-blocking banner (never a blocking
  // Alert/modal) shown when a load/refresh/background resync couldn't
  // reach the server — the existing on-screen watchlist (or, on a cold
  // start that never even got that far, an empty list) stays exactly as
  // it was. Cleared the moment any subsequent load/refresh succeeds.
  const [syncWarning, setSyncWarning] = useState(false);
  const [ticker, setTicker] = useState('');
  const [selectedAssetType, setSelectedAssetType] = useState<AssetType>('Stock');
  const [isAdding, setIsAdding] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Tracks which ETFs have already triggered a structural stop notification
  // this session, so we notify once per crossing rather than on every
  // render while the price stays inside the warning zone.
  const notifiedTickersRef = useRef<Set<string>>(new Set());

  // Loads the saved watchlist: reads it from AsyncStorage, then fetches a
  // fresh live quote for each ticker. Used both by the focus effect below
  // (every tab focus, including the initial mount) AND by the AppState
  // foreground hook further down (whenever the load never actually landed
  // real data — see that hook's own comment). `isStillRelevant` lets each
  // caller supply its own cancellation check: the focus effect needs
  // "still the same focus session" (its own per-focus `isActive` flag,
  // since this screen never unmounts on blur); the AppState hook just
  // needs "still mounted at all".
  const loadAmbushData = useCallback(
    async (isStillRelevant: () => boolean) => {
      // Hydration hardening: a storage read/parse failure is NOT the
      // same thing as "the user has no saved tickers" — those must be
      // told apart. Falling back to DEFAULT_ENTRIES here (as this code
      // used to) would silently overwrite a real watchlist with
      // AAPL/TSLA on a mere transient AsyncStorage hiccup, and this can
      // re-run on every tab focus (not just app startup), so that could
      // happen repeatedly during normal use.
      let entries: AmbushTickerEntry[];
      try {
        entries = (await loadAmbushTickerEntries()) ?? DEFAULT_ENTRIES;
      } catch (error) {
        console.error(
          '[hydration] Failed to read the Ambush watchlist from storage; retaining the ' +
            'previous state instead of falling back to defaults.',
          error,
        );
        // CACHE INTEGRITY: deliberately NOT setStocksTrusted — canPersistRef
        // stays false, so the persistence effect below keeps refusing to
        // write until a load actually succeeds.
        if (isStillRelevant()) {
          setSyncWarning(true);
          setIsInitializing(false);
        }
        return;
      }

      if (entries.length === 0) {
        // A genuinely empty, successfully-read list (the user deleted
        // every ticker) is valid state, not a failure — show it as-is,
        // and this IS trustworthy enough to persist.
        if (isStillRelevant()) {
          setStocksTrusted([]);
          setSyncWarning(false);
          setIsInitializing(false);
        }
        return;
      }

      // CONCURRENCY LIMITING: fetched in small batches (not one giant
      // Promise.allSettled over the whole watchlist at once) to avoid
      // overwhelming the network with N simultaneous connections — this
      // still awaits the full queue before moving on, so isInitializing
      // below only flips to false once every batch has resolved.
      const results = await fetchInChunks(entries, (entry) => fetchStockData(entry.ticker));

      // DATA-LOSS FIX: one row per stored ticker, ALWAYS, in storage order.
      // A ticker whose fetch failed becomes an 'unavailable' row (see
      // createUnavailableQuote) instead of being dropped. The old code kept
      // only the fulfilled results, so the persistence effect then saved
      // that shorter list and permanently removed every ticker whose fetch
      // happened to fail. Because this list now matches storage entry for
      // entry, it is safe to mark trusted and persist even when EVERY fetch
      // failed: saving it writes back exactly what was read.
      const loadedStocks: SatelliteAmbushAsset[] = entries.map((entry, index) => {
        const result = results[index];
        return {
          ...entry,
          ...(result.status === 'fulfilled' ? result.value : createUnavailableQuote()),
          layer: 'Satellite',
        };
      });

      const failedCount = results.filter((result) => result.status === 'rejected').length;
      if (failedCount > 0) {
        console.error(
          `[hydration] ${failedCount} of ${entries.length} ticker fetch(es) failed; keeping those ` +
            'tickers with an unavailable price instead of dropping them.',
        );
      }

      if (isStillRelevant()) {
        setStocksTrusted(loadedStocks);
        // Screen-level banner only for a sync-wide failure; a partial
        // failure shows on the affected cards.
        setSyncWarning(failedCount === entries.length);
        setIsInitializing(false);
      }
    },
    [setStocksTrusted],
  );

  // Load the saved watchlist every time this tab gains focus (including the
  // initial mount) — not just once on mount — so a backup restored from the
  // Portfolio tab's Import menu (a separate mounted screen this one has no
  // direct handle to) is picked up as soon as the user switches back here,
  // rather than only on the next full app restart.
  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      loadAmbushData(() => isActive);
      return () => {
        isActive = false;
      };
    }, [loadAmbushData]),
  );

  // CLOSED-LOOP WATCHLIST: a Satellite/Quality position liquidated on the
  // Portfolio tab arrives here directly (see notifyAmbushAddition), so it
  // joins this screen's in-memory list right away. Without this, the
  // ticker would only be in storage, and this screen's own persistence
  // effect could overwrite storage with its older list before the next
  // focus reload picked the ticker up.
  //
  // Skipped while canPersistRef is false (this screen's load never got
  // trustworthy data). Merging into that untrusted list would mark it
  // trustworthy and let the persistence effect write the near-empty result
  // over the real watchlist. Storage already holds the ticker in that case,
  // so the next successful load shows it.
  useEffect(
    () =>
      subscribeToAmbushAdditions((addedStock) => {
        if (!canPersistRef.current) {
          return;
        }
        const addedTicker = addedStock.ticker.trim().toUpperCase();
        setStocksTrusted((prevStocks) =>
          prevStocks.some((stock) => stock.ticker.trim().toUpperCase() === addedTicker)
            ? prevStocks
            : [...prevStocks, { ...addedStock, layer: 'Satellite' }],
        );
      }),
    [setStocksTrusted],
  );

  // Tracks whether this screen is still mounted — read from the AppState
  // foreground hook below, which (unlike the focus effect above) isn't
  // itself tied to a per-focus cancellation session: an OS-level
  // background/foreground cycle doesn't blur/refocus this tab.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Declared here (ABOVE the useAppForegroundRefresh call below, which
  // reads it) rather than down near handleCopyAmbushData where it used to
  // live — a function used by a hook call must be declared before that
  // call lexically, or React's own compiler/lint rules flag it as
  // "accessed before declared," even though the actual runtime behavior
  // is identical either way (the hook only ever invokes this
  // asynchronously, long after the whole component body has finished
  // executing for that render).
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const tickersToRefresh = stocks.map((stock) => stock.ticker);

      if (tickersToRefresh.length === 0) {
        // Nothing to refresh — either a genuinely empty watchlist, or the
        // initial load never got real data in. Skip entirely rather than
        // calling setStocksTrusted with a no-op empty result, which would
        // wrongly mark canPersistRef as trustworthy and let the
        // persistence effect below write this still-empty `[]` over
        // whatever real data is (or isn't) actually sitting in
        // AsyncStorage.
        return;
      }

      // CONCURRENCY LIMITING: see loadAmbushData above — small batches,
      // not one Promise.allSettled over the whole list. Parameter
      // deliberately not named `t` here (unlike elsewhere in this file)
      // to avoid shadowing the translation function from
      // usePipelineLanguage.
      const results = await fetchInChunks(tickersToRefresh, (tickerSymbol) => fetchStockData(tickerSymbol));

      // Map successful results back by ticker (rather than by index) so a
      // concurrent add/delete during the fetch can't misalign the data.
      const freshQuotes = new Map<string, StockQuote>();
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          freshQuotes.set(tickersToRefresh[index], result.value);
        }
      });

      // STATE PROTECTION: every single refresh attempt failed (network
      // outage, or the app got backgrounded mid-refresh and the OS
      // suspended the request) — every position below falls through to
      // `return stock` unchanged, so nothing is lost, but the user should
      // still see a subtle signal that this refresh didn't actually reach
      // the server. A PARTIAL failure is treated as success — normal,
      // everyday flakiness for one ticker, not a sync-wide problem.
      if (freshQuotes.size === 0) {
        console.error(
          '[sync] All ticker refresh(es) failed (network issue, or the app was backgrounded ' +
            'mid-refresh); retaining the current watchlist instead of clearing it.',
        );
        setSyncWarning(true);
        return;
      }
      setSyncWarning(false);

      setStocksTrusted((prevStocks) =>
        prevStocks.map((stock) => {
          const freshQuote = freshQuotes.get(stock.ticker);
          return freshQuote ? { ...stock, ...freshQuote } : stock;
        }),
      );
    } finally {
      setRefreshing(false);
    }
  };

  // ANDROID BACKGROUND/FOREGROUND DATA HYDRATION FIX (requirement #2): once
  // the app returns to the foreground after being backgrounded, re-sync
  // with the server. Same two-tier recovery as PortfolioScreen
  // (index.tsx): re-run the FULL load if it never actually landed real
  // data (canPersistRef.current still false — the load was still in
  // flight, or failed outright, when backgrounded), otherwise just a
  // lightweight pull-to-refresh-equivalent resync of the tickers already
  // on screen.
  //
  // Deliberately a plain inline function, NOT wrapped in useCallback: see
  // useAppForegroundRefresh's own comment — it always re-captures whatever
  // function is passed to it on every render, so callers never need to
  // memoize this.
  useAppForegroundRefresh(() => {
    if (canPersistRef.current) {
      onRefresh();
    } else {
      loadAmbushData(() => isMountedRef.current);
    }
  });

  // CACHE INTEGRITY: keep AsyncStorage in sync with the current watchlist
  // — but ONLY once there's trustworthy data to sync. Skipped while
  // initializing, AND skipped whenever canPersistRef is still false — see
  // its own declaration above for exactly which failure paths that covers.
  useEffect(() => {
    if (isInitializing || !canPersistRef.current) {
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
      // A placeholder price (priceStatus 'unavailable') must never fire a
      // notification.
      const isNearStructuralStop =
        stock.priceStatus === 'live' &&
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
      setStocksTrusted((prevStocks) => [
        ...prevStocks,
        { ticker: normalizedTicker, assetType: selectedAssetType, ...quote, layer: 'Satellite' },
      ]);
      setTicker('');
    } catch (error) {
      const message = error instanceof Error ? error.message : t('fetchFailedForTicker', { ticker: normalizedTicker });
      Alert.alert(t('cannotAddTickerTitle'), message);
    } finally {
      setIsAdding(false);
    }
  };

  // Stable identity (useCallback) is required for the React.memo on
  // StockCard to actually skip re-renders — an inline function here would
  // be a new reference on every AmbushRadarScreen render, which would
  // defeat memo() by changing this prop for every row on every render.
  const handleDeleteTicker = useCallback(
    (tickerToDelete: string) => {
      setStocksTrusted((prevStocks) => prevStocks.filter((stock) => stock.ticker !== tickerToDelete));
    },
    [setStocksTrusted],
  );

  // UNIFIED RADAR: Satellite assets (the real, persisted watchlist) plus,
  // in development builds only, the demo Quality assets. The demo rows are
  // merged here, into what's DISPLAYED, never into `stocks`. `stocks` is
  // what the persistence effect saves, so putting them there would write
  // them into the user's real watchlist. Release builds (__DEV__ false)
  // show only real assets.
  const radarAssets = useMemo<AmbushAsset[]>(
    () => (__DEV__ ? [...stocks, ...DEMO_QUALITY_AMBUSH_ASSETS] : stocks),
    [stocks],
  );

  // COLLAPSIBLE SECTIONS: one flag per readiness zone; true means
  // collapsed. In-memory only, so every section starts expanded again
  // after an app restart.
  const [collapsedSections, setCollapsedSections] =
    useState<Record<AmbushReadinessZone, boolean>>(INITIAL_COLLAPSED_SECTIONS);

  const toggleSection = useCallback((zone: AmbushReadinessZone) => {
    setCollapsedSections((previous) => ({ ...previous, [zone]: !previous[zone] }));
  }, []);

  // READINESS GROUPING: Value Zone, Watch, Invalidated (see
  // groupAmbushByReadiness for the rules and in-zone ordering). A zone with
  // no assets is left out, so there's never an empty header. A collapsed
  // zone keeps its header (with its full count) but passes no rows. The
  // asset objects are passed through unchanged, so StockCard's and
  // QualityAmbushCard's memo() still skip rows that didn't change.
  const sections = useMemo<AmbushSection[]>(() => {
    const groups = groupAmbushByReadiness(radarAssets);
    return AMBUSH_READINESS_ORDER.filter((zone) => groups[zone].length > 0).map((zone) => ({
      key: zone,
      title: t(AMBUSH_ZONE_TITLE_KEY[zone]),
      accentColor: ambushZoneColors(colors, zone).accent,
      count: groups[zone].length,
      isCollapsed: collapsedSections[zone],
      data: collapsedSections[zone] ? [] : groups[zone],
    }));
  }, [radarAssets, collapsedSections, colors, t]);

  // Picks the card by layer. A Quality card gets its section's zone for
  // its status strip. Quality rows have no delete button: today they are
  // only demo rows, which aren't part of the saved watchlist.
  const renderRadarItem = useCallback<SectionListRenderItem<AmbushAsset, AmbushSectionInfo>>(
    ({ item, section }) =>
      item.layer === 'Quality' ? (
        <QualityAmbushCard asset={item} zone={section.key} />
      ) : (
        <StockCard stock={item} onDelete={handleDeleteTicker} />
      ),
    [handleDeleteTicker],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: AmbushSection }) => (
      <TouchableOpacity
        style={styles.sectionHeader}
        onPress={() => toggleSection(section.key)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded: !section.isCollapsed }}
        accessibilityLabel={`${section.title} · ${section.count}`}>
        <View style={[styles.sectionHeaderAccent, { backgroundColor: section.accentColor }]} />
        {/* Translated title first, count second: the same bidi-safe
            word-first order Portfolio's section titles use. The count is
            the zone's full size, so it stays accurate while collapsed. */}
        <Text style={[styles.sectionHeaderTitle, { color: section.accentColor }]}>
          {section.title} · {section.count}
        </Text>
        <Ionicons
          name={section.isCollapsed ? 'chevron-down' : 'chevron-up'}
          size={18}
          color={section.accentColor}
          style={styles.sectionHeaderChevron}
        />
      </TouchableOpacity>
    ),
    [styles, toggleSection],
  );

  const handleCopyAmbushData = async () => {
    const timestamp = new Date().toLocaleString();
    const report = [`Ambush Radar Report — ${timestamp}`, '', ...formatAmbushLines(stocks)].join(
      '\n',
    );

    try {
      await Clipboard.setStringAsync(report);
      Alert.alert(t('copiedTitle'), t('ambushDataCopiedMessage'));
    } catch {
      Alert.alert(t('copyFailedTitle'), t('ambushCopyFailedMessage'));
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <StatusBar style={isDarkMode ? 'light' : 'dark'} />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('ambushRadar')}</Text>
      </View>

      <View style={styles.exportRow}>
        <TouchableOpacity style={styles.exportButton} onPress={handleCopyAmbushData}>
          <Text style={styles.exportButtonText}>{t('copyAmbushData')}</Text>
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
        <TouchableOpacity
          style={[styles.addButton, isAdding && styles.addButtonDisabled]}
          onPress={handleAddTicker}
          disabled={isAdding}>
          {isAdding ? (
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <Text style={styles.addButtonText}>{t('add')}</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* STATE PROTECTION: a subtle, non-blocking banner — never a
          cleared list, never a blocking Alert — shown whenever the most
          recent sync attempt (initial load, pull-to-refresh, or an
          AppState-triggered background resync) couldn't actually reach
          the server. Whatever was already on screen is left exactly
          as-is; this disappears the moment any later sync succeeds. */}
      {syncWarning && (
        <View style={styles.syncWarningBanner}>
          <Text style={styles.syncWarningBannerText}>{t('syncFailedWarning')}</Text>
        </View>
      )}

      {isInitializing ? (
        <View style={styles.initializingContainer}>
          <PullToRefreshLogo isRefreshing overlay={false} />
          <Text style={styles.initializingText}>{t('loadingAmbush')}</Text>
        </View>
      ) : (
        <View style={styles.listWrapper}>
          <PullToRefreshLogo isRefreshing={refreshing} />
          <SectionList<AmbushAsset, AmbushSectionInfo>
            sections={sections}
            keyExtractor={extractAmbushItemKey}
            renderItem={renderRadarItem}
            renderSectionHeader={renderSectionHeader}
            // Sticky on both platforms (Android defaults to off): the
            // header stays pinned while its group scrolls under it. Its
            // opaque background (see sectionHeader) keeps cards from
            // showing through.
            stickySectionHeadersEnabled
            initialNumToRender={10}
            windowSize={5}
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
    </SafeAreaView>
  );
}

// A factory (not a module-level StyleSheet.create) so it can be re-derived
// whenever the active theme changes — see the identical note in
// StockCard.tsx. Called from a useMemo(() => createStyles(colors,
// isDarkMode), [colors, isDarkMode]) above, so it only actually re-runs on
// a real theme change, not on every render.
function createStyles(colors: PipelineColorScheme, isDarkMode: boolean, language: Language) {
  // RUTHLESS LOCALIZATION AUDIT: every visible string on this screen now
  // renders translated (t()) text, so every text style below switches
  // alignment/writingDirection with the language too.
  const isHebrew = language === 'he';

  return StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    headerTitle: {
      // RTL/LTR LOCALIZATION: right-aligned in Hebrew, left-aligned in
      // English; numeric values/ticker symbols elsewhere are deliberately
      // left at their default (LTR) alignment regardless (see
      // StockCard.tsx).
      color: colors.textPrimary,
      fontSize: 28,
      fontWeight: '700',
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    exportRow: {
      paddingHorizontal: 16,
      marginBottom: 12,
    },
    exportButton: {
      backgroundColor: colors.cardBackground,
      borderRadius: 8,
      paddingVertical: 10,
      alignItems: 'center',
      ...(isDarkMode
        ? null
        : {
            shadowColor: '#000',
            shadowOpacity: 0.08,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }),
    },
    exportButtonText: {
      color: colors.textPrimary,
      fontSize: 14,
      fontWeight: '600',
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      marginBottom: 8,
      gap: 8,
      zIndex: 10,
    },
    // STATE PROTECTION: same warning/warningText color tokens as
    // StockCard.tsx's own per-card structural-stop banner, for visual
    // consistency, but normal (not negative) margins since this one sits
    // at the screen level, not nested inside a card — matches
    // PortfolioScreen's identical syncWarningBanner in index.tsx.
    syncWarningBanner: {
      backgroundColor: colors.warning,
      marginHorizontal: 16,
      marginBottom: 12,
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
      color: colors.textPrimary,
      fontSize: 14,
      fontWeight: '600',
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    addButton: {
      backgroundColor: colors.bullish,
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
      color: colors.textPrimary,
      fontSize: 16,
      fontWeight: '700',
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    listWrapper: {
      flex: 1,
    },
    listContent: {
      paddingBottom: 24,
    },
    // MACRO TREND SECTION HEADER: a thin accent bar plus the section title in
    // the same accent color (bullish/bearish/textSecondary). The opaque
    // `background` fill matters because headers are sticky: cards scroll
    // underneath, and a transparent header would let them show through.
    // Horizontal padding matches StockCard's own 16px side margin, so the
    // header lines up with the cards under it. The row flips for Hebrew so
    // the accent bar always sits at the start of the reading direction.
    sectionHeader: {
      flexDirection: isHebrew ? 'row-reverse' : 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.background,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 8,
    },
    sectionHeaderAccent: {
      width: 4,
      height: 16,
      borderRadius: 2,
    },
    // flex: 1 pushes the chevron to the far end of the header row (the
    // right in English, the left in Hebrew, since the row flips).
    sectionHeaderTitle: {
      flex: 1,
      fontSize: 15,
      fontWeight: '700',
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    sectionHeaderChevron: {
      marginHorizontal: 4,
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
  });
}
