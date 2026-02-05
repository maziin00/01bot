// MarketMaker - main bot logic

import type { NordUser } from "@n1xyz/nord-ts";
import Decimal from "decimal.js";
import type { DebouncedFunc } from "lodash-es";
import { throttle } from "lodash-es";
import { BinancePriceFeed } from "../../pricing/binance.js";
import { CoinbasePriceFeed } from "../../pricing/coinbase.js";
import {
	FairPriceCalculator,
	type FairPriceConfig,
	type FairPriceProvider,
} from "../../pricing/fair-price.js";
import { AccountStream, type FillEvent } from "../../sdk/account.js";
import { createZoClient, type ZoClient } from "../../sdk/client.js";
import { ZoOrderbookStream } from "../../sdk/orderbook.js";
import {
	type CachedOrder,
	cancelOrders,
	updateQuotes,
} from "../../sdk/orders.js";
import type { MidPrice, Quote } from "../../types.js";
import { log } from "../../utils/logger.js";
import type { MarketMakerConfig } from "./config.js";
import { type PositionConfig, PositionTracker } from "./position.js";
import { Quoter } from "./quoter.js";

export type { MarketMakerConfig } from "./config.js";

// API order type from SDK
interface ApiOrder {
	orderId: bigint | number;
	marketId: number;
	side: "bid" | "ask";
	price: number | string;
	size: number | string;
}

// Convert API orders to cached orders
function mapApiOrdersToCached(orders: ApiOrder[]): CachedOrder[] {
	return orders.map((o) => ({
		orderId: o.orderId.toString(),
		side: o.side,
		price: new Decimal(o.price),
		size: new Decimal(o.size),
	}));
}

// Derive Binance symbol from market symbol (e.g., "BTC-PERP" → "btcusdt")
function deriveBinanceSymbol(marketSymbol: string): string {
	const baseSymbol = marketSymbol
		.replace(/-PERP$/i, "")
		.replace(/USD$/i, "")
		.toLowerCase();
	return `${baseSymbol}usdt`;
}

function deriveCoinbaseSymbol(marketSymbol: string): string {
	const baseSymbol = marketSymbol
		.replace(/-PERP$/i, "")
		.replace(/USD$/i, "")
		.toUpperCase();
	return `${baseSymbol}-USD`;
}

interface ReferenceFeed {
	connect(): void;
	close(): void;
	getMidPrice(): MidPrice | null;
	onPrice: ((price: MidPrice) => void) | null;
}

type ReferenceFeedKind = "binance" | "coinbase" | "zo";

export class MarketMaker {
	private client: ZoClient | null = null;
	private marketId = 0;
	private marketSymbol = "";
	private accountStream: AccountStream | null = null;
	private orderbookStream: ZoOrderbookStream | null = null;
	private referenceFeed: ReferenceFeed | null = null;
	private referenceFeedKind: ReferenceFeedKind = "zo";
	private referenceFeedPriority: ReferenceFeedKind[] = ["zo"];
	private referenceFeedIndex = 0;
	private referenceFeedHealthInterval: ReturnType<typeof setInterval> | null = null;
	private lastReferencePriceAt = 0;
	private readonly referenceStaleMs = 20_000;
	private readonly referenceHealthCheckMs = 5_000;
	private binanceSymbol = "";
	private coinbaseSymbol = "";
	private fairPriceCalc: FairPriceProvider | null = null;
	private positionTracker: PositionTracker | null = null;
	private quoter: Quoter | null = null;
	private isRunning = false;
	private lastLoggedSampleCount = -1;
	private activeOrders: CachedOrder[] = [];
	private orderFirstSeenMs = new Map<string, number>();
	private isUpdating = false;
	private hasLoggedZoOnlyReady = false;
	private fetchInfoPromise: Promise<void> | null = null;
	private throttledUpdate: DebouncedFunc<
		(fairPrice: number) => Promise<void>
	> | null = null;
	private statusInterval: ReturnType<typeof setInterval> | null = null;
	private orderSyncInterval: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly config: MarketMakerConfig,
		private readonly privateKey: string,
	) {}

	private requireClient(): ZoClient {
		if (!this.client) {
			throw new Error("Client not initialized");
		}
		return this.client;
	}

	async run(): Promise<void> {
		log.banner();

		await this.initialize();
		this.setupEventHandlers();
		await this.syncInitialOrders();
		this.startIntervals();
		this.registerShutdownHandlers();

		log.info("Warming up price feeds...");
		await this.waitForever();
	}

	private async initialize(): Promise<void> {
		this.throttledUpdate = throttle(
			(fairPrice: number) => this.executeUpdate(fairPrice),
			this.config.updateThrottleMs,
			{ leading: true, trailing: true },
		);

		this.client = await createZoClient(this.privateKey);
		const { nord, accountId } = this.client;

		// Find market by symbol (e.g., "BTC" matches "BTC-PERP")
		const market = nord.markets.find((m) =>
			m.symbol.toUpperCase().startsWith(this.config.symbol.toUpperCase()),
		);
		if (!market) {
			const available = nord.markets.map((m) => m.symbol).join(", ");
			throw new Error(
				`Market "${this.config.symbol}" not found. Available: ${available}`,
			);
		}
		this.marketId = market.marketId;
		this.marketSymbol = market.symbol;

		this.binanceSymbol = deriveBinanceSymbol(market.symbol);
		this.coinbaseSymbol = deriveCoinbaseSymbol(market.symbol);
		this.referenceFeedPriority = this.buildReferenceFeedPriority();
		this.referenceFeedIndex = 0;
		this.applyReferenceFeed(this.referenceFeedPriority[0]);
		this.logConfig(this.binanceSymbol, this.coinbaseSymbol);

		// Initialize strategy components
		const fairPriceConfig: FairPriceConfig = {
			windowMs: this.config.fairPriceWindowMs,
			minSamples: this.config.warmupSeconds,
		};
		const positionConfig: PositionConfig = {
			closeThresholdUsd: this.config.closeThresholdUsd,
			syncIntervalMs: this.config.positionSyncIntervalMs,
		};

		this.fairPriceCalc = new FairPriceCalculator(fairPriceConfig);
		this.positionTracker = new PositionTracker(positionConfig);
		this.quoter = new Quoter(
			market.priceDecimals,
			market.sizeDecimals,
			this.config.spreadBps,
			this.config.takeProfitBps,
			this.config.orderSizeUsd,
		);

		// Initialize streams
		this.accountStream = new AccountStream(nord, accountId);
		this.orderbookStream = new ZoOrderbookStream(nord, this.marketSymbol);
		this.isRunning = true;
	}

	private setupEventHandlers(): void {
		const { user, accountId } = this.requireClient();

		// Account stream - fill events
		this.accountStream?.syncOrders(user, accountId);
		this.accountStream?.setOnFill((fill: FillEvent) => {
			log.fill(fill.side === "bid" ? "buy" : "sell", fill.price, fill.size);
			this.positionTracker?.applyFill(fill.side, fill.size, fill.price);
			// Cancel all orders when entering close mode
			if (this.positionTracker?.isCloseMode(fill.price)) {
				this.cancelOrdersAsync();
			}
		});

		// Price feeds
		if (this.referenceFeed) {
			this.referenceFeed.onPrice = (price) => this.handleReferencePrice(price);
		}
		if (this.orderbookStream) {
			this.orderbookStream.onPrice = (price) => this.handleZoPrice(price);
		}

		// Start connections
		this.accountStream?.connect();
		this.orderbookStream?.connect();
		this.referenceFeed?.connect();
		this.startReferenceHealthCheck();
	}

	private handleReferencePrice(referencePrice: MidPrice): void {
		this.lastReferencePriceAt = Date.now();
		const zoPrice = this.orderbookStream?.getMidPrice();
		if (
			zoPrice &&
			Math.abs(referencePrice.timestamp - zoPrice.timestamp) < 1000
		) {
			this.fairPriceCalc?.addSample(zoPrice.mid, referencePrice.mid);
		}

		if (!this.isRunning) return;

		const fairPrice = this.fairPriceCalc?.getFairPrice(referencePrice.mid);
		if (!fairPrice) {
			this.logWarmupProgress(referencePrice);
			return;
		}

		// Log ready on first valid fair price
		if (this.lastLoggedSampleCount < this.config.warmupSeconds) {
			this.lastLoggedSampleCount = this.config.warmupSeconds;
			log.info(`Ready! Fair price: $${fairPrice.toFixed(2)}`);
		}

		this.throttledUpdate?.(fairPrice);
	}

	private handleZoPrice(zoPrice: MidPrice): void {
		if (!this.referenceFeed) {
			if (!this.isRunning) return;
			if (!this.hasLoggedZoOnlyReady) {
				this.hasLoggedZoOnlyReady = true;
				log.info("External feed disabled. Using 01 mid price as fair price.");
			}
			this.throttledUpdate?.(zoPrice.mid);
			return;
		}

		const binancePrice = this.referenceFeed.getMidPrice();
		if (
			binancePrice &&
			Math.abs(zoPrice.timestamp - binancePrice.timestamp) < 1000
		) {
			this.fairPriceCalc?.addSample(zoPrice.mid, binancePrice.mid);
		}
	}

	private logWarmupProgress(binancePrice: MidPrice): void {
		const state = this.fairPriceCalc?.getState();
		if (!state || state.samples === this.lastLoggedSampleCount) return;

		this.lastLoggedSampleCount = state.samples;
		const zoPrice = this.orderbookStream?.getMidPrice();
		const offsetBps =
			state.offset !== null && binancePrice.mid > 0
				? ((state.offset / binancePrice.mid) * 10000).toFixed(1)
				: "--";
		log.info(
			`Warming up: ${state.samples}/${this.config.warmupSeconds} samples | Binance $${binancePrice.mid.toFixed(2)} | 01 $${zoPrice?.mid.toFixed(2) ?? "--"} | Offset ${offsetBps}bps`,
		);
	}

	private async syncInitialOrders(): Promise<void> {
		const { user, accountId } = this.requireClient();

		await this.safeFetchInfo(user);
		const existingOrders = (user.orders[accountId] ?? []) as ApiOrder[];
		const marketOrders = existingOrders.filter(
			(o) => o.marketId === this.marketId,
		);
		this.activeOrders = mapApiOrdersToCached(marketOrders);
		this.refreshOrderAges(this.activeOrders);

		if (this.activeOrders.length > 0) {
			log.info(`Synced ${this.activeOrders.length} existing orders`);
		}

		// Start position sync
		this.positionTracker?.startSync(
			user,
			accountId,
			this.marketId,
			() => this.safeFetchInfo(user),
		);
	}

	private startIntervals(): void {
		const { user, accountId } = this.requireClient();

		// Status display
		this.statusInterval = setInterval(() => {
			this.logStatus();
		}, this.config.statusIntervalMs);

		// Order sync
		this.orderSyncInterval = setInterval(() => {
			this.syncOrders(user, accountId);
		}, this.config.orderSyncIntervalMs);
	}

	private registerShutdownHandlers(): void {
		const shutdown = () => this.shutdown();
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	}

	private async shutdown(): Promise<void> {
		log.shutdown();
		this.isRunning = false;
		this.throttledUpdate?.cancel();
		this.positionTracker?.stopSync();

		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		if (this.orderSyncInterval) {
			clearInterval(this.orderSyncInterval);
			this.orderSyncInterval = null;
		}
		if (this.referenceFeedHealthInterval) {
			clearInterval(this.referenceFeedHealthInterval);
			this.referenceFeedHealthInterval = null;
		}

		this.referenceFeed?.close();
		this.orderbookStream?.close();
		this.accountStream?.close();

		try {
			if (this.activeOrders.length > 0 && this.client) {
				await cancelOrders(this.client.user, this.activeOrders);
				log.info(`Cancelled ${this.activeOrders.length} orders. Goodbye!`);
				this.activeOrders = [];
			} else {
				log.info("No active orders. Goodbye!");
			}
		} catch (err) {
			log.error("Shutdown error:", err);
		}

		process.exit(0);
	}

	private async waitForever(): Promise<void> {
		await new Promise(() => {});
	}

	private async executeUpdate(fairPrice: number): Promise<void> {
		if (this.isUpdating) return;
		this.isUpdating = true;

		try {
			if (!this.positionTracker || !this.quoter || !this.client) {
				return;
			}

			const quotingCtx = this.positionTracker.getQuotingContext(fairPrice);
			const { positionState } = quotingCtx;

			if (positionState.sizeBase !== 0) {
				log.position(
					positionState.sizeBase,
					positionState.sizeUsd,
					positionState.isLong,
					positionState.isCloseMode,
				);
			}

			const bbo = this.orderbookStream?.getBBO() ?? null;
			const quotes = this.quoter.getQuotes(quotingCtx, bbo);
			const stableQuotes = this.applyRequoteGuard(quotes);

			if (stableQuotes.length === 0) {
				log.warn("No quotes generated (order size too small)");
				return;
			}

			const bid = stableQuotes.find((q) => q.side === "bid");
			const ask = stableQuotes.find((q) => q.side === "ask");
			const isClose = positionState.isCloseMode;
			const spreadBps = isClose
				? this.config.takeProfitBps
				: this.config.spreadBps;
			log.quote(
				bid?.price.toNumber() ?? null,
				ask?.price.toNumber() ?? null,
				fairPrice,
				spreadBps,
				isClose ? "close" : "normal",
			);

			const newOrders = await updateQuotes(
				this.client.user,
				this.marketId,
				this.activeOrders,
				stableQuotes,
			);
			this.activeOrders = newOrders;
			this.refreshOrderAges(this.activeOrders);
		} catch (err) {
			log.error("Update error:", err);
			this.activeOrders = [];
		} finally {
			this.isUpdating = false;
		}
	}

	private logConfig(binanceSymbol: string, coinbaseSymbol: string): void {
		const feedLabel = this.referenceFeedLabel(binanceSymbol, coinbaseSymbol);
		log.config({
			Market: this.marketSymbol,
			"Price Feed": feedLabel,
			Spread: `${this.config.spreadBps} bps`,
			"Take Profit": `${this.config.takeProfitBps} bps`,
			"Order Size": `$${this.config.orderSizeUsd}`,
			"Close Mode": `>=$${this.config.closeThresholdUsd}`,
		});
	}

	private buildReferenceFeedPriority(): ReferenceFeedKind[] {
		if (this.config.referenceFeed === "binance") {
			return ["binance", "coinbase", "zo"];
		}
		if (this.config.referenceFeed === "coinbase") {
			return ["coinbase", "binance", "zo"];
		}
		return ["zo"];
	}

	private createReferenceFeed(kind: ReferenceFeedKind): ReferenceFeed | null {
		if (kind === "binance") {
			return new BinancePriceFeed(this.binanceSymbol);
		}
		if (kind === "coinbase") {
			return new CoinbasePriceFeed(this.coinbaseSymbol);
		}
		return null;
	}

	private applyReferenceFeed(kind: ReferenceFeedKind): void {
		this.referenceFeed?.close();
		this.referenceFeed = null;
		this.referenceFeedKind = kind;
		this.lastReferencePriceAt = 0;

		const nextFeed = this.createReferenceFeed(kind);
		if (!nextFeed) return;
		nextFeed.onPrice = (price) => this.handleReferencePrice(price);
		this.referenceFeed = nextFeed;
	}

	private startReferenceHealthCheck(): void {
		if (this.referenceFeedHealthInterval || !this.config.enableFeedFailover) {
			return;
		}
		this.referenceFeedHealthInterval = setInterval(() => {
			if (!this.isRunning || !this.referenceFeed) {
				return;
			}
			const sinceLastPrice = this.lastReferencePriceAt > 0
				? Date.now() - this.lastReferencePriceAt
				: Number.POSITIVE_INFINITY;
			if (sinceLastPrice < this.referenceStaleMs) {
				return;
			}
			if (this.referenceFeedIndex >= this.referenceFeedPriority.length - 1) {
				return;
			}

			const previous = this.referenceFeedPriority[this.referenceFeedIndex];
			this.referenceFeedIndex += 1;
			const next = this.referenceFeedPriority[this.referenceFeedIndex];
			log.warn(
				`Reference feed stale (${previous}, ${Math.round(sinceLastPrice)}ms). Switching to ${next}.`,
			);
			this.applyReferenceFeed(next);
			this.referenceFeed?.connect();
		}, this.referenceHealthCheckMs);
	}

	private referenceFeedLabel(binanceSymbol: string, coinbaseSymbol: string): string {
		if (this.config.referenceFeed === "binance") {
			return `Binance (${binanceSymbol})`;
		}
		if (this.config.referenceFeed === "coinbase") {
			return `Coinbase (${coinbaseSymbol})`;
		}
		return "01 mid only";
	}

	private async safeFetchInfo(user: NordUser): Promise<void> {
		if (this.fetchInfoPromise) {
			return this.fetchInfoPromise;
		}
		this.fetchInfoPromise = user.fetchInfo().finally(() => {
			this.fetchInfoPromise = null;
		});
		return this.fetchInfoPromise;
	}

	private cancelOrdersAsync(): void {
		if (this.activeOrders.length === 0 || !this.client) return;
		const orders = this.activeOrders;
		cancelOrders(this.client.user, orders)
			.then(() => {
				this.activeOrders = [];
			})
			.catch((err) => {
				log.error("Failed to cancel orders:", err);
				this.activeOrders = [];
			});
	}

	private syncOrders(user: NordUser, accountId: number): void {
		this.safeFetchInfo(user)
			.then(() => {
				const apiOrders = (user.orders[accountId] ?? []) as ApiOrder[];
				const marketOrders = apiOrders.filter(
					(o) => o.marketId === this.marketId,
				);
				this.activeOrders = mapApiOrdersToCached(marketOrders);
				this.refreshOrderAges(this.activeOrders);
			})
			.catch((err) => {
				log.error("Order sync error:", err);
			});
	}

	private refreshOrderAges(orders: CachedOrder[]): void {
		const now = Date.now();
		const liveIds = new Set(orders.map((order) => order.orderId));
		for (const order of orders) {
			if (!this.orderFirstSeenMs.has(order.orderId)) {
				this.orderFirstSeenMs.set(order.orderId, now);
			}
		}
		for (const trackedId of Array.from(this.orderFirstSeenMs.keys())) {
			if (!liveIds.has(trackedId)) {
				this.orderFirstSeenMs.delete(trackedId);
			}
		}
	}

	private priceDiffBps(a: Decimal, b: Decimal): number {
		const denom = a.abs().plus(b.abs()).div(2);
		if (denom.lte(0)) return 0;
		return a.minus(b).abs().div(denom).mul(10000).toNumber();
	}

	private applyRequoteGuard(quotes: Quote[]): Quote[] {
		this.refreshOrderAges(this.activeOrders);
		const now = Date.now();
		const currentBySide = new Map<"bid" | "ask", CachedOrder>();
		for (const order of this.activeOrders) {
			if (!currentBySide.has(order.side)) {
				currentBySide.set(order.side, order);
			}
		}

		return quotes.map((quote) => {
			const existing = currentBySide.get(quote.side);
			if (!existing) return quote;

			const ageMs = now - (this.orderFirstSeenMs.get(existing.orderId) ?? now);
			const priceBps = this.priceDiffBps(existing.price, quote.price);
			const isFresh = ageMs < this.config.minOrderAgeMs;
			const isWithinThreshold = priceBps <= this.config.requoteThresholdBps;

			if (isFresh || isWithinThreshold) {
				return {
					...quote,
					price: existing.price,
					size: existing.size,
				};
			}
			return quote;
		});
	}

	private logStatus(): void {
		if (!this.isRunning) return;

		const pos = this.positionTracker?.getBaseSize() ?? 0;
		const bids = this.activeOrders.filter((o) => o.side === "bid");
		const asks = this.activeOrders.filter((o) => o.side === "ask");

		const formatOrder = (o: CachedOrder) =>
			`$${o.price.toFixed(2)}x${o.size.toString()}`;

		const bidStr = bids.map(formatOrder).join(",") || "-";
		const askStr = asks.map(formatOrder).join(",") || "-";

		log.info(
			`STATUS: pos=${pos.toFixed(5)} | bid=[${bidStr}] | ask=[${askStr}]`,
		);
	}
}
