export type Side = "buy" | "sell";

export type Quote = {
  price: number;
  size: number;
  side: Side;
};

export type Order = {
  id: string;
  symbol: string;
  price: number;
  size: number;
  side: Side;
  createdAt: number;
};

export type OrderBook = {
  bid: number;
  ask: number;
  mid: number;
};

export interface ExchangeAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getOrderBook(symbol: string): Promise<OrderBook>;
  listOpenOrders(symbol: string): Promise<Order[]>;
  placeOrder(symbol: string, quote: Quote): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
}
