export type BotConfig = {
  symbol: string;
  baseQuoteSpreadBps: number;
  orderSize: number;
  updateIntervalMs: number;
  maxActiveOrders: number;
};

export const defaultConfig: BotConfig = {
  symbol: process.env.BOT_SYMBOL ?? "BTC/USDT",
  baseQuoteSpreadBps: Number(process.env.BOT_SPREAD_BPS ?? 20),
  orderSize: Number(process.env.BOT_ORDER_SIZE ?? 0.01),
  updateIntervalMs: Number(process.env.BOT_UPDATE_MS ?? 2000),
  maxActiveOrders: Number(process.env.BOT_MAX_ORDERS ?? 4)
};

export const validateConfig = (config: BotConfig): void => {
  if (!config.symbol) {
    throw new Error("BOT_SYMBOL is required");
  }
  if (Number.isNaN(config.baseQuoteSpreadBps) || config.baseQuoteSpreadBps <= 0) {
    throw new Error("BOT_SPREAD_BPS must be a positive number");
  }
  if (Number.isNaN(config.orderSize) || config.orderSize <= 0) {
    throw new Error("BOT_ORDER_SIZE must be a positive number");
  }
  if (Number.isNaN(config.updateIntervalMs) || config.updateIntervalMs < 250) {
    throw new Error("BOT_UPDATE_MS must be at least 250");
  }
  if (Number.isNaN(config.maxActiveOrders) || config.maxActiveOrders < 2) {
    throw new Error("BOT_MAX_ORDERS must be at least 2");
  }
};
