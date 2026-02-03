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

	const useBinanceFeed =
		(process.env.USE_BINANCE_FEED ?? "true").toLowerCase() !== "false";

	const bot = new MarketMaker(
		{
			...DEFAULT_CONFIG,
			useBinanceFeed,
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
