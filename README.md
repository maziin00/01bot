# 01bot Market Maker (TypeScript)

Bot market maker sederhana berbasis TypeScript. Versi ini memakai **simulated exchange** agar gampang dicoba tanpa koneksi API real. Setelah flow stabil, adapter exchange bisa diganti ke Binance/OKX/dll.

## Fitur
- Quote bid/ask berdasarkan mid price dan spread (basis poin)
- Loop pembaruan order sederhana
- Adapter exchange abstrak (mudah diganti)

## Quick start

```bash
npm install
npm run dev
```

## Konfigurasi (env)

Salin `.env.example` lalu sesuaikan.

| Env | Deskripsi | Default |
| --- | --- | --- |
| `BOT_SYMBOL` | Pair symbol | `BTC/USDT` |
| `BOT_SPREAD_BPS` | Spread dalam basis poin | `20` |
| `BOT_ORDER_SIZE` | Ukuran order | `0.01` |
| `BOT_UPDATE_MS` | Interval update (ms) | `2000` |
| `BOT_MAX_ORDERS` | Batas order aktif | `4` |

## Struktur

```
src/
  exchange/
    types.ts
    simulated.ts
  strategy/
    marketMaker.ts
  bot.ts
  config.ts
  index.ts
```

## Next steps
- Tambahkan adapter exchange real (REST/WebSocket)
- Tambah model inventory & skew
- Risk limits dan circuit breaker

> Catatan: contoh ini hanya untuk riset/edukasi, **bukan** saran finansial.
