import { useEffect, useState } from 'react';

import { searchTickers, type TickerSearchResult } from '@/services/api';

const SEARCH_DEBOUNCE_MS = 300;

type ResolvedSearch = {
  query: string;
  results: TickerSearchResult[];
};

// Debounced ticker search, shared by the Ambush Radar and Portfolio
// autocomplete inputs. Waits for typing to pause before calling the API,
// and ignores results from a stale (superseded) request.
//
// State is only set from the request callback (react-hooks/set-state-in-
// effect): an empty query and "still searching" are derived during render
// from the last resolved query instead of being set inside the effect.
export function useTickerSearch(query: string) {
  const trimmedQuery = query.trim();
  const [resolved, setResolved] = useState<ResolvedSearch>({ query: '', results: [] });

  useEffect(() => {
    if (!trimmedQuery) {
      return;
    }

    let isCancelled = false;
    const timeoutId = setTimeout(() => {
      searchTickers(trimmedQuery).then((searchResults) => {
        if (!isCancelled) {
          setResolved({ query: trimmedQuery, results: searchResults });
        }
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      isCancelled = true;
      clearTimeout(timeoutId);
    };
  }, [trimmedQuery]);

  const results = trimmedQuery ? resolved.results : [];
  const isSearching = trimmedQuery !== '' && resolved.query !== trimmedQuery;
  return { results, isSearching };
}
