// MarketMaker configuration

export interface MarketMakerConfig {
	readonly symbol: string; // e.g., "BTC" or "ETH"
	readonly useBinanceFeed: boolean; // Use Binance as reference feed
	readonly referenceFeed: "binance" | "coinbase" | "zo"; // Reference feed source
	readonly enableFeedFailover: boolean; // Auto-switch to fallback feed when stale
	readonly spreadBps: number; // Spread from fair price (bps)
	readonly takeProfitBps: number; // Spread in close mode (bps)
	readonly requoteThresholdBps: number; // Keep existing order if price diff <= threshold
	readonly minOrderAgeMs: number; // Keep fresh orders at least this long before replace
	readonly orderSizeUsd: number; // Order size in USD
	readonly closeThresholdUsd: number; // Trigger close mode when position >= this
	readonly warmupSeconds: number; // Seconds to warm up before quoting
	readonly updateThrottleMs: number; // Min interval between quote updates
	readonly orderSyncIntervalMs: number; // Interval for syncing orders from API
	readonly statusIntervalMs: number; // Interval for status display
	readonly fairPriceWindowMs: number; // Window for fair price calculation
	readonly positionSyncIntervalMs: number; // Interval for position sync
}

// Default configuration values (symbol must be provided)
export const DEFAULT_CONFIG: Omit<MarketMakerConfig, "symbol"> = {
	useBinanceFeed: true,
	referenceFeed: "binance",
	enableFeedFailover: true,
	spreadBps: 10,
	takeProfitBps: 5,
	requoteThresholdBps: 3,
	minOrderAgeMs: 10000,
	orderSizeUsd: 100,
	closeThresholdUsd: 10,
	warmupSeconds: 10,
	updateThrottleMs: 100,
	orderSyncIntervalMs: 3000,
	statusIntervalMs: 1000,
	fairPriceWindowMs: 5 * 60 * 1000, // 5 minutes
	positionSyncIntervalMs: 5000,
};
