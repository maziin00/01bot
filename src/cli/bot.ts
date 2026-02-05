// CLI entry point for market maker bot

import "dotenv/config";
import { DEFAULT_CONFIG } from "../bots/mm/config.js";
import { MarketMaker } from "../bots/mm/index.js";
import { log } from "../utils/logger.js";

function parseEnvNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function parseReferenceFeed(): "binance" | "coinbase" | "zo" {
	const raw = (process.env.REFERENCE_FEED ?? "").trim().toLowerCase();
	if (raw === "coinbase") return "coinbase";
	if (raw === "zo" || raw === "off" || raw === "none") return "zo";
	if (raw === "binance") return "binance";

	// Backward compatibility
	const useBinance =
		(process.env.USE_BINANCE_FEED ?? "true").toLowerCase() !== "false";
	return useBinance ? "binance" : "zo";
}

function parseEnvBoolean(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;
	return fallback;
}

function main(): void {
	const symbol = process.argv[2]?.toUpperCase();

	if (!symbol) {
		console.error("Usage: npm run bot -- <symbol>");
		console.error("Example: npm run bot -- BTC");
		process.exit(1);
	}

	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey) {
		console.error("Missing required environment variable: PRIVATE_KEY");
		process.exit(1);
	}

	const referenceFeed = parseReferenceFeed();

	const bot = new MarketMaker(
		{
			...DEFAULT_CONFIG,
			referenceFeed,
			enableFeedFailover: parseEnvBoolean(
				"ENABLE_FEED_FAILOVER",
				DEFAULT_CONFIG.enableFeedFailover,
			),
			spreadBps: parseEnvNumber("SPREAD_BPS", DEFAULT_CONFIG.spreadBps),
			takeProfitBps: parseEnvNumber(
				"TAKE_PROFIT_BPS",
				DEFAULT_CONFIG.takeProfitBps,
			),
			closeThresholdUsd: parseEnvNumber(
				"CLOSE_THRESHOLD_USD",
				DEFAULT_CONFIG.closeThresholdUsd,
			),
			orderSizeUsd: parseEnvNumber(
				"ORDER_SIZE_USD",
				DEFAULT_CONFIG.orderSizeUsd,
			),
			requoteThresholdBps: parseEnvNumber(
				"REQUOTE_THRESHOLD_BPS",
				DEFAULT_CONFIG.requoteThresholdBps,
			),
			minOrderAgeMs: parseEnvNumber(
				"MIN_ORDER_AGE_MS",
				DEFAULT_CONFIG.minOrderAgeMs,
			),
			symbol,
		},
		privateKey,
	);

	bot.run().catch((err) => {
		log.error("Fatal error:", err);
		process.exit(1);
	});
}

main();
