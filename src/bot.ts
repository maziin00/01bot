import { BotConfig } from "./config.js";
import { ExchangeAdapter } from "./exchange/types.js";
import { buildQuotes } from "./strategy/marketMaker.js";

export class MarketMakerBot {
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly exchange: ExchangeAdapter,
    private readonly config: BotConfig
  ) {}

  async start(): Promise<void> {
    await this.exchange.connect();
    await this.syncQuotes();
    this.interval = setInterval(() => {
      void this.syncQuotes();
    }, this.config.updateIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    await this.exchange.disconnect();
  }

  private async syncQuotes(): Promise<void> {
    const { symbol, baseQuoteSpreadBps, orderSize, maxActiveOrders } = this.config;
    const orderBook = await this.exchange.getOrderBook(symbol);
    const quotes = buildQuotes({
      mid: orderBook.mid,
      spreadBps: baseQuoteSpreadBps,
      size: orderSize
    });

    const openOrders = await this.exchange.listOpenOrders(symbol);
    const ordersToCancel = openOrders.slice(0, Math.max(0, openOrders.length - maxActiveOrders));
    await Promise.all(ordersToCancel.map((order) => this.exchange.cancelOrder(order.id)));

    for (const quote of quotes) {
      await this.exchange.placeOrder(symbol, quote);
    }

    const priceLine = `mid=${orderBook.mid.toFixed(2)} bid=${orderBook.bid.toFixed(2)} ask=${orderBook.ask.toFixed(2)}`;
    const orderLine = quotes.map((quote) => `${quote.side}@${quote.price}`).join(" | ");
    process.stdout.write(`[mm] ${priceLine} -> ${orderLine}\n`);
  }
}
