import WebSocket from "ws";
import type { MidPrice, PriceCallback } from "../types.js";
import { log } from "../utils/logger.js";

const COINBASE_WS = "wss://advanced-trade-ws.coinbase.com";
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const STALE_THRESHOLD_MS = 60_000;
const STALE_CHECK_INTERVAL_MS = 10_000;

export class CoinbasePriceFeed {
	private ws: WebSocket | null = null;
	private latestPrice: MidPrice | null = null;
	private reconnectTimeout: NodeJS.Timeout | null = null;
	private pingInterval: NodeJS.Timeout | null = null;
	private pongTimeout: NodeJS.Timeout | null = null;
	private staleCheckInterval: NodeJS.Timeout | null = null;
	private lastMessageTime = 0;
	private isClosing = false;
	private readonly productId: string;

	onPrice: PriceCallback | null = null;

	constructor(productId: string = "BTC-USD") {
		this.productId = productId.toUpperCase();
	}

	connect(): void {
		if (this.ws) return;
		log.info(`Connecting to Coinbase (${COINBASE_WS}) for ${this.productId}...`);
		this.ws = new WebSocket(COINBASE_WS);

		this.ws.on("open", () => {
			log.info("Coinbase connected");
			this.lastMessageTime = Date.now();
			this.ws?.send(JSON.stringify({
				type: "subscribe",
				product_ids: [this.productId],
				channel: "ticker"
			}));
			this.startPingInterval();
			this.startStaleCheck();
		});

		this.ws.on("message", (data: Buffer) => {
			this.lastMessageTime = Date.now();
			const parsed = this.parseTicker(data.toString());
			if (!parsed) return;
			this.latestPrice = parsed;
			this.onPrice?.(parsed);
		});

		this.ws.on("pong", () => {
			this.clearPongTimeout();
		});

		this.ws.on("error", (err: Error) => {
			log.error("Coinbase WebSocket error:", err.message);
		});

		this.ws.on("close", () => {
			log.warn("Coinbase disconnected");
			this.cleanup();
			if (!this.isClosing) {
				this.scheduleReconnect();
			}
		});
	}

	private parseTicker(raw: string): MidPrice | null {
		try {
			const msg = JSON.parse(raw) as {
				channel?: string;
				events?: Array<{ tickers?: Array<{ product_id?: string; best_bid?: string; best_ask?: string; price?: string }> }>;
			};
			if (msg.channel !== "ticker" || !msg.events?.length) return null;

			for (const event of msg.events) {
				for (const ticker of event.tickers ?? []) {
					if (ticker.product_id?.toUpperCase() !== this.productId) continue;
					const bid = Number(ticker.best_bid ?? ticker.price);
					const ask = Number(ticker.best_ask ?? ticker.price);
					if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
					return {
						bid,
						ask,
						mid: (bid + ask) / 2,
						timestamp: Date.now()
					};
				}
			}
		} catch {
			return null;
		}
		return null;
	}

	private startPingInterval(): void {
		this.stopPingInterval();
		this.pingInterval = setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.ws.ping();
				this.startPongTimeout();
			}
		}, PING_INTERVAL_MS);
	}

	private stopPingInterval(): void {
		if (!this.pingInterval) return;
		clearInterval(this.pingInterval);
		this.pingInterval = null;
	}

	private startPongTimeout(): void {
		this.clearPongTimeout();
		this.pongTimeout = setTimeout(() => {
			log.warn("Coinbase pong timeout - connection dead");
			this.ws?.terminate();
		}, PONG_TIMEOUT_MS);
	}

	private clearPongTimeout(): void {
		if (!this.pongTimeout) return;
		clearTimeout(this.pongTimeout);
		this.pongTimeout = null;
	}

	private startStaleCheck(): void {
		this.stopStaleCheck();
		this.staleCheckInterval = setInterval(() => {
			if (this.isClosing) return;
			const now = Date.now();
			const timeSinceMessage = now - this.lastMessageTime;
			if (this.lastMessageTime > 0 && timeSinceMessage > STALE_THRESHOLD_MS) {
				log.warn(`Coinbase stale (${timeSinceMessage}ms since last message). Reconnecting...`);
				this.ws?.terminate();
			}
		}, STALE_CHECK_INTERVAL_MS);
	}

	private stopStaleCheck(): void {
		if (!this.staleCheckInterval) return;
		clearInterval(this.staleCheckInterval);
		this.staleCheckInterval = null;
	}

	private cleanup(): void {
		this.stopPingInterval();
		this.clearPongTimeout();
		this.stopStaleCheck();
		this.ws = null;
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimeout) return;
		log.info("Reconnecting to Coinbase in 3s...");
		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			this.connect();
		}, 3000);
	}

	getMidPrice(): MidPrice | null {
		return this.latestPrice;
	}

	close(): void {
		this.isClosing = true;
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		this.cleanup();
		this.ws?.close();
	}
}
