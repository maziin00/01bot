import { Quote } from "../exchange/types.js";

export type MarketMakerParams = {
  mid: number;
  spreadBps: number;
  size: number;
};

export const buildQuotes = ({ mid, spreadBps, size }: MarketMakerParams): Quote[] => {
  const halfSpread = mid * (spreadBps / 10000) * 0.5;
  const bidPrice = Math.max(0.01, mid - halfSpread);
  const askPrice = mid + halfSpread;
  return [
    { side: "buy", price: Number(bidPrice.toFixed(2)), size },
    { side: "sell", price: Number(askPrice.toFixed(2)), size }
  ];
};
