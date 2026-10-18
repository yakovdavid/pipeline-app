import type { AmbushLayer } from '@/types/ambush';
import type { AssetType } from '@/types/asset';

// AMBUSH → PORTFOLIO HANDOFF: the Ambush Radar's "Buy" button hands the
// ticker to the Portfolio screen, which owns the cash balance and the
// "Execute Trade" flow, so both entry points (Add Asset and the radar)
// share one trade path.
//
// Kept in memory rather than in navigation params on purpose: a pending
// request is consumed exactly once (takePendingPortfolioBuy), so it can't
// re-trigger when the tab is revisited. If the Portfolio screen isn't
// listening yet, the request waits here until it mounts and takes it.

export type PortfolioBuyRequest = {
  ticker: string;
  assetType: AssetType;
  // The radar layer maps one-to-one onto the Portfolio layer of the same
  // name.
  layer: AmbushLayer;
};

type PortfolioBuyListener = () => void;

let pendingRequest: PortfolioBuyRequest | null = null;
const listeners = new Set<PortfolioBuyListener>();

export function requestPortfolioBuy(request: PortfolioBuyRequest): void {
  pendingRequest = request;
  listeners.forEach((listener) => listener());
}

export function takePendingPortfolioBuy(): PortfolioBuyRequest | null {
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}

// Listeners are only told that a request is waiting; they call
// takePendingPortfolioBuy to claim it.
export function subscribeToPortfolioBuyRequests(listener: PortfolioBuyListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
