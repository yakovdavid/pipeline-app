import { useEffect, useState } from 'react';

import { searchTickers, type TickerSearchResult } from '@/services/api';

const SEARCH_DEBOUNCE_MS = 300;

// Debounced ticker search, shared by the Ambush Radar and Portfolio
// autocomplete inputs. Waits for typing to pause before calling the API,
// and ignores results from a stale (superseded) request.
export function useTickerSearch(query: string) {
  const [results, setResults] = useState<TickerSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    let isCancelled = false;
    setIsSearching(true);

    const timeoutId = setTimeout(() => {
      searchTickers(trimmedQuery).then((searchResults) => {
        if (!isCancelled) {
          setResults(searchResults);
          setIsSearching(false);
        }
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      isCancelled = true;
      clearTimeout(timeoutId);
    };
  }, [query]);

  return { results, isSearching };
}
