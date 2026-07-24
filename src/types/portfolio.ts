export type PortfolioCategory = 'Core' | 'Satellite' | 'Quality';

// What actually gets persisted to AsyncStorage: just the symbol and its
// allocation bucket. Price is always re-fetched live, never stored stale.
export type PortfolioTickerEntry = {
  ticker: string;
  category: PortfolioCategory;
};

export type PortfolioStock = PortfolioTickerEntry & {
  price: number;
};
