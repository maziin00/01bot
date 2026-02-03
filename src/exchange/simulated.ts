import { ExchangeAdapter, Order, OrderBook, Quote } from "./types.js";

const randomId = () => Math.random().toString(36).slice(2, 10);

export class SimulatedExchange implements ExchangeAdapter {
  private midPrice = 64000;
  private openOrders: Order[] = [];
  private readonly volatility = 45;

  async connect(): Promise<void> {
    return;
  }

  async disconnect(): Promise<void> {
    this.openOrders = [];
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    void symbol;
    const drift = (Math.random() - 0.5) * this.volatility;
    this.midPrice = Math.max(100, this.midPrice + drift);
    const spread = this.midPrice * 0.0006;
    const bid = this.midPrice - spread;
    const ask = this.midPrice + spread;
    return { bid, ask, mid: this.midPrice };
  }

  async listOpenOrders(symbol: string): Promise<Order[]> {
    return this.openOrders.filter((order) => order.symbol === symbol);
  }

  async placeOrder(symbol: string, quote: Quote): Promise<Order> {
    const order: Order = {
      id: randomId(),
      symbol,
      price: quote.price,
      size: quote.size,
      side: quote.side,
      createdAt: Date.now()
    };
    this.openOrders.push(order);
    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.openOrders = this.openOrders.filter((order) => order.id !== orderId);
  }
}
