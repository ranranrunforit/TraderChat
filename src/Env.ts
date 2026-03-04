import { Source } from "./lib/domain/DataFecther"

export const dev = false

// Use Yahoo Finance for all stock/A-share/forex data
// Binance source only works for crypto pairs (BTCUSDT, ETHUSDT)
export const source: Source = Source.yfinance
