import { defaultConfig, validateConfig } from "./config.js";
import { SimulatedExchange } from "./exchange/simulated.js";
import { MarketMakerBot } from "./bot.js";

const run = async (): Promise<void> => {
  validateConfig(defaultConfig);
  const exchange = new SimulatedExchange();
  const bot = new MarketMakerBot(exchange, defaultConfig);

  const shutdown = async () => {
    await bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });

  await bot.start();
};

void run();
