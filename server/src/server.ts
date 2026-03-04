import express from 'express';
import cors from 'cors';
import { GoogleGenAI, Type } from '@google/genai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Serve Vite-built frontend from public/ (populated by Dockerfile)
const publicDir = join(__dirname, '..', 'public');
if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
    console.log('📁 Serving frontend from', publicDir);
}

const PORT = parseInt(process.env.PORT || '3001');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY environment variable is required');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ═══════════════════════════════════════════════════
// Tool implementations — fetch real market data
// ═══════════════════════════════════════════════════

const YAHOO_BASE = 'https://mmmmmm.io/yfinance/v8/finance/chart';
const BINANCE_BASE = 'https://api.binance.us/api/v3';

const timeframeToYahoo: Record<string, string> = {
    '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1wk', '1M': '1mo',
};

const timeframeToBinance: Record<string, string> = {
    '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w', '1M': '1M',
};

interface Candle {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

async function fetchYahooData(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    const interval = timeframeToYahoo[timeframe] || '1d';
    const endTime = Math.floor(Date.now() / 1000);
    // rough estimate: go back enough time for the limit
    const msPerBar: Record<string, number> = {
        '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
        '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1wk': 604_800_000, '1mo': 2_592_000_000,
    };
    const barMs = msPerBar[interval] || 86_400_000;
    const startTime = Math.floor((Date.now() - limit * barMs * 1.5) / 1000);

    const url = `${YAHOO_BASE}/${symbol}?interval=${interval}&period1=${startTime}&period2=${endTime}`;
    const resp = await fetch(url);
    const data = await resp.json() as any;

    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps = result.timestamp || [];
    const quotes = result.indicators?.quote?.[0] || {};

    return timestamps.slice(-limit).map((ts: number, i: number) => ({
        time: new Date(ts * 1000).toISOString(),
        open: Number((quotes.open?.[i] ?? 0).toFixed(4)),
        high: Number((quotes.high?.[i] ?? 0).toFixed(4)),
        low: Number((quotes.low?.[i] ?? 0).toFixed(4)),
        close: Number((quotes.close?.[i] ?? 0).toFixed(4)),
        volume: Math.round(quotes.volume?.[i] ?? 0),
    }));
}

async function fetchBinanceData(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    const interval = timeframeToBinance[timeframe] || '1d';
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const resp = await fetch(url);
    const data = await resp.json() as any[];

    if (!Array.isArray(data)) return [];

    return data.map((item: any[]) => ({
        time: new Date(item[0]).toISOString(),
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5]),
    }));
}

function detectSource(symbol: string): 'yahoo' | 'binance' {
    // Binance symbols are typically all uppercase without dots or dashes (e.g., BTCUSDT)
    // Yahoo symbols have dots, dashes, or carets (e.g., AAPL, ^GSPC, BTC-USD)
    if (/^[A-Z0-9]+$/.test(symbol) && symbol.endsWith('USDT')) {
        return 'binance';
    }
    return 'yahoo';
}

async function getStockData(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    const source = detectSource(symbol);
    try {
        if (source === 'binance') {
            return await fetchBinanceData(symbol, timeframe, limit);
        } else {
            return await fetchYahooData(symbol, timeframe, limit);
        }
    } catch (err) {
        console.error(`Error fetching ${source} data for ${symbol}:`, err);
        return [];
    }
}

// Simple indicator calculations
function calcSMA(closes: number[], period: number): (number | null)[] {
    return closes.map((_, i) => {
        if (i < period - 1) return null;
        const slice = closes.slice(i - period + 1, i + 1);
        return Number((slice.reduce((a, b) => a + b, 0) / period).toFixed(4));
    });
}

function calcEMA(closes: number[], period: number): (number | null)[] {
    const k = 2 / (period + 1);
    const ema: (number | null)[] = [];
    let prev: number | null = null;
    for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) {
            ema.push(null);
        } else if (prev === null) {
            prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
            ema.push(Number(prev.toFixed(4)));
        } else {
            prev = closes[i] * k + prev * (1 - k);
            ema.push(Number(prev.toFixed(4)));
        }
    }
    return ema;
}

function calcRSI(closes: number[], period = 14): (number | null)[] {
    const rsi: (number | null)[] = [];
    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < closes.length; i++) {
        if (i === 0) { rsi.push(null); continue; }
        const change = closes[i] - closes[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        if (i <= period) {
            avgGain += gain;
            avgLoss += loss;
            if (i === period) {
                avgGain /= period;
                avgLoss /= period;
                const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
                rsi.push(Number((100 - 100 / (1 + rs)).toFixed(2)));
            } else {
                rsi.push(null);
            }
        } else {
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
            const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsi.push(Number((100 - 100 / (1 + rs)).toFixed(2)));
        }
    }
    return rsi;
}

function calcMACD(closes: number[]): { macd: (number | null)[], signal: (number | null)[], histogram: (number | null)[] } {
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const macdLine = ema12.map((v, i) => (v !== null && ema26[i] !== null) ? Number((v - ema26[i]!).toFixed(4)) : null);

    const macdValues = macdLine.filter(v => v !== null) as number[];
    const signalEma = calcEMA(macdValues, 9);

    let si = 0;
    const signal = macdLine.map(v => {
        if (v === null) return null;
        const s = signalEma[si++];
        return s;
    });

    const histogram = macdLine.map((v, i) => (v !== null && signal[i] !== null) ? Number((v - signal[i]!).toFixed(4)) : null);
    return { macd: macdLine, signal, histogram };
}

function calcBB(closes: number[], period = 20, mult = 2): { upper: (number | null)[], middle: (number | null)[], lower: (number | null)[] } {
    const middle = calcSMA(closes, period);
    const upper: (number | null)[] = [];
    const lower: (number | null)[] = [];

    for (let i = 0; i < closes.length; i++) {
        if (middle[i] === null) {
            upper.push(null);
            lower.push(null);
        } else {
            const slice = closes.slice(i - period + 1, i + 1);
            const std = Math.sqrt(slice.reduce((sum, v) => sum + (v - middle[i]!) ** 2, 0) / period);
            upper.push(Number((middle[i]! + mult * std).toFixed(4)));
            lower.push(Number((middle[i]! - mult * std).toFixed(4)));
        }
    }
    return { upper, middle, lower };
}

// ── Additional indicator calculations ──

function calcATR(candles: Candle[], period = 14): (number | null)[] {
    const atr: (number | null)[] = [null];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high, low = candles[i].low, prevClose = candles[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        if (i < period) { atr.push(null); continue; }
        if (i === period) {
            let sum = 0;
            for (let j = 1; j <= period; j++) {
                const h = candles[j].high, l = candles[j].low, pc = candles[j - 1].close;
                sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
            }
            atr.push(Number((sum / period).toFixed(4)));
        } else {
            const prev = atr[i - 1]!;
            atr.push(Number(((prev * (period - 1) + tr) / period).toFixed(4)));
        }
    }
    return atr;
}

function calcKDJ(candles: Candle[], kPeriod = 9, dPeriod = 3): { k: (number | null)[], d: (number | null)[], j: (number | null)[] } {
    const kArr: (number | null)[] = [];
    const dArr: (number | null)[] = [];
    const jArr: (number | null)[] = [];
    let prevK = 50, prevD = 50;
    for (let i = 0; i < candles.length; i++) {
        if (i < kPeriod - 1) { kArr.push(null); dArr.push(null); jArr.push(null); continue; }
        let highest = -Infinity, lowest = Infinity;
        for (let j = i - kPeriod + 1; j <= i; j++) {
            if (candles[j].high > highest) highest = candles[j].high;
            if (candles[j].low < lowest) lowest = candles[j].low;
        }
        const rsv = highest === lowest ? 50 : ((candles[i].close - lowest) / (highest - lowest)) * 100;
        const k = (2 / 3) * prevK + (1 / 3) * rsv;
        const d = (2 / 3) * prevD + (1 / 3) * k;
        const j = 3 * k - 2 * d;
        kArr.push(Number(k.toFixed(2)));
        dArr.push(Number(d.toFixed(2)));
        jArr.push(Number(j.toFixed(2)));
        prevK = k; prevD = d;
    }
    return { k: kArr, d: dArr, j: jArr };
}

function calcVWAP(candles: Candle[]): (number | null)[] {
    let cumVolPrice = 0, cumVol = 0;
    return candles.map(c => {
        const typical = (c.high + c.low + c.close) / 3;
        cumVolPrice += typical * c.volume;
        cumVol += c.volume;
        return cumVol > 0 ? Number((cumVolPrice / cumVol).toFixed(4)) : null;
    });
}

function calcOBV(candles: Candle[]): number[] {
    const obv: number[] = [0];
    for (let i = 1; i < candles.length; i++) {
        if (candles[i].close > candles[i - 1].close) obv.push(obv[i - 1] + candles[i].volume);
        else if (candles[i].close < candles[i - 1].close) obv.push(obv[i - 1] - candles[i].volume);
        else obv.push(obv[i - 1]);
    }
    return obv;
}

function calcWilliamsR(candles: Candle[], period = 14): (number | null)[] {
    return candles.map((c, i) => {
        if (i < period - 1) return null;
        let highest = -Infinity, lowest = Infinity;
        for (let j = i - period + 1; j <= i; j++) {
            if (candles[j].high > highest) highest = candles[j].high;
            if (candles[j].low < lowest) lowest = candles[j].low;
        }
        return highest === lowest ? -50 : Number((((highest - c.close) / (highest - lowest)) * -100).toFixed(2));
    });
}

function calcStochastic(candles: Candle[], kPeriod = 14, dPeriod = 3): { k: (number | null)[], d: (number | null)[] } {
    const kArr: (number | null)[] = candles.map((c, i) => {
        if (i < kPeriod - 1) return null;
        let highest = -Infinity, lowest = Infinity;
        for (let j = i - kPeriod + 1; j <= i; j++) {
            if (candles[j].high > highest) highest = candles[j].high;
            if (candles[j].low < lowest) lowest = candles[j].low;
        }
        return highest === lowest ? 50 : Number((((c.close - lowest) / (highest - lowest)) * 100).toFixed(2));
    });
    const kValues = kArr.filter(v => v !== null) as number[];
    const dArr = calcSMA(kValues, dPeriod);
    let di = 0;
    return { k: kArr, d: kArr.map(v => v === null ? null : dArr[di++] ?? null) };
}

function calcCCI(candles: Candle[], period = 20): (number | null)[] {
    return candles.map((c, i) => {
        if (i < period - 1) return null;
        const slice = candles.slice(i - period + 1, i + 1);
        const tps = slice.map(s => (s.high + s.low + s.close) / 3);
        const mean = tps.reduce((a, b) => a + b, 0) / period;
        const meanDev = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
        return meanDev === 0 ? 0 : Number((((c.high + c.low + c.close) / 3 - mean) / (0.015 * meanDev)).toFixed(2));
    });
}

function calcFibonacci(candles: Candle[]): Record<string, number> {
    const high = candles.reduce((m, c) => c.high > m ? c.high : m, candles[0].high);
    const low = candles.reduce((m, c) => c.low < m ? c.low : m, candles[0].low);
    const diff = high - low;
    return {
        high: Number(high.toFixed(4)),
        low: Number(low.toFixed(4)),
        'level_0.236': Number((high - diff * 0.236).toFixed(4)),
        'level_0.382': Number((high - diff * 0.382).toFixed(4)),
        'level_0.5': Number((high - diff * 0.5).toFixed(4)),
        'level_0.618': Number((high - diff * 0.618).toFixed(4)),
        'level_0.786': Number((high - diff * 0.786).toFixed(4)),
    };
}

function calcPivotPoints(candles: Candle[]): Record<string, number> {
    const last = candles[candles.length - 1];
    const p = (last.high + last.low + last.close) / 3;
    return {
        pivot: Number(p.toFixed(4)),
        r1: Number((2 * p - last.low).toFixed(4)),
        r2: Number((p + last.high - last.low).toFixed(4)),
        r3: Number((last.high + 2 * (p - last.low)).toFixed(4)),
        s1: Number((2 * p - last.high).toFixed(4)),
        s2: Number((p - last.high + last.low).toFixed(4)),
        s3: Number((last.low - 2 * (last.high - p)).toFixed(4)),
    };
}

function calcVolumeAnalysis(candles: Candle[]): Record<string, number> {
    const volumes = candles.map(c => c.volume);
    const avg20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length);
    const avg5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, volumes.length);
    const latest = volumes[volumes.length - 1];
    return {
        latest_volume: latest,
        avg_volume_5: Math.round(avg5),
        avg_volume_20: Math.round(avg20),
        volume_ratio: Number((latest / avg20).toFixed(2)),
        volume_trend: avg5 > avg20 ? 1 : -1,
    };
}

type IndicatorResult = Record<string, unknown>;

function calculateIndicators(candles: Candle[], indicators: string[]): IndicatorResult {
    const closes = candles.map(c => c.close);
    const result: IndicatorResult = {};

    for (const ind of indicators) {
        const lower = ind.toLowerCase();
        if (lower.startsWith('sma')) {
            const period = parseInt(lower.replace('sma', '')) || 20;
            result[`sma_${period}`] = calcSMA(closes, period).slice(-20);
        } else if (lower.startsWith('ema')) {
            const period = parseInt(lower.replace('ema', '')) || 20;
            result[`ema_${period}`] = calcEMA(closes, period).slice(-20);
        } else if (lower === 'rsi') {
            result.rsi_14 = calcRSI(closes).slice(-20);
        } else if (lower === 'macd') {
            const macd = calcMACD(closes);
            result.macd = { line: macd.macd.slice(-20), signal: macd.signal.slice(-20), histogram: macd.histogram.slice(-20) };
        } else if (lower === 'bb') {
            const bb = calcBB(closes);
            result.bollinger_bands = { upper: bb.upper.slice(-20), middle: bb.middle.slice(-20), lower: bb.lower.slice(-20) };
        } else if (lower === 'kdj') {
            const kdj = calcKDJ(candles);
            result.kdj = { k: kdj.k.slice(-20), d: kdj.d.slice(-20), j: kdj.j.slice(-20) };
        } else if (lower === 'atr') {
            result.atr_14 = calcATR(candles).slice(-20);
        } else if (lower === 'vwap') {
            result.vwap = calcVWAP(candles).slice(-20);
        } else if (lower === 'obv') {
            result.obv = calcOBV(candles).slice(-20);
        } else if (lower === 'williams_r' || lower === 'wr') {
            result.williams_r = calcWilliamsR(candles).slice(-20);
        } else if (lower === 'stochastic' || lower === 'stoch') {
            const stoch = calcStochastic(candles);
            result.stochastic = { k: stoch.k.slice(-20), d: stoch.d.slice(-20) };
        } else if (lower === 'cci') {
            result.cci_20 = calcCCI(candles).slice(-20);
        } else if (lower === 'fibonacci' || lower === 'fib') {
            result.fibonacci = calcFibonacci(candles);
        } else if (lower === 'pivot' || lower === 'pivot_points') {
            result.pivot_points = calcPivotPoints(candles);
        } else if (lower === 'volume' || lower === 'vol') {
            result.volume_analysis = calcVolumeAnalysis(candles);
        }
    }

    return result;
}

// ═══════════════════════════════════════════════════
// Gemini tool definitions
// ═══════════════════════════════════════════════════

const tools = [{
    functionDeclarations: [
        {
            name: 'get_stock_data',
            description: 'Fetch recent OHLCV (Open, High, Low, Close, Volume) candle data for a stock or cryptocurrency. Use Yahoo Finance symbols for stocks (e.g., AAPL, TSLA, ^GSPC, BTC-USD). For Chinese A-shares use .SS for Shanghai (e.g., 600519.SS for 贵州茅台) and .SZ for Shenzhen (e.g., 000001.SZ for 平安银行). For Hong Kong use .HK (e.g., 0700.HK for 腾讯). For crypto use Binance symbols (e.g., BTCUSDT, ETHUSDT).',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    symbol: { type: Type.STRING, description: 'Ticker symbol. US stocks: AAPL, TSLA, ^GSPC. Chinese A-shares: 600519.SS (Shanghai), 000001.SZ (Shenzhen). HK: 0700.HK. Crypto: BTCUSDT. Forex: EURUSD=X' },
                    timeframe: { type: Type.STRING, description: 'Candle timeframe: 1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M', enum: ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M'] },
                    limit: { type: Type.NUMBER, description: 'Number of candles to fetch (default 100, max 500)' },
                },
                required: ['symbol'],
            },
        },
        {
            name: 'calculate_indicators',
            description: 'Calculate technical indicators for a stock or crypto. Available indicators: SMA (any period, e.g., sma20, sma50, sma200), EMA (any period, e.g., ema9, ema21), RSI (14-period), MACD (12,26,9), BB (Bollinger Bands, 20-period).',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    symbol: { type: Type.STRING, description: 'Ticker symbol. US stocks: AAPL. A-shares: 600519.SS, 000001.SZ. HK: 0700.HK. Crypto: BTCUSDT' },
                    timeframe: { type: Type.STRING, description: 'Candle timeframe', enum: ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M'] },
                    indicators: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'List of indicators. Available: sma20, sma50, sma200, ema12, ema26, rsi, macd, bb, kdj, atr, vwap, obv, williams_r, stochastic, cci, fibonacci, pivot_points, volume. Use "all" to get everything.',
                    },
                },
                required: ['symbol', 'indicators'],
            },
        },
        {
            name: 'get_fundamentals',
            description: 'Fetch fundamental financial data for a stock (P/E ratio, market cap, revenue, earnings, profit margins). Use this for stocks/equities, NOT crypto. Helps provide a more complete analysis combining technical + fundamental.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    symbol: { type: Type.STRING, description: 'Stock ticker symbol (e.g., AAPL, 002065.SZ, 0700.HK)' },
                },
                required: ['symbol'],
            },
        },
        {
            name: 'update_chart',
            description: 'ALWAYS call this FIRST. Switches the VibeTrader chart to the requested symbol/timeframe with built-in EMA, MACD, RSI indicators. The user sees the chart update immediately.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    symbol: { type: Type.STRING, description: 'Ticker symbol. US: AAPL. A-shares: 600519.SS, 000001.SZ. HK: 0700.HK. Crypto: BTCUSDT' },
                    timeframe: { type: Type.STRING, description: 'Timeframe', enum: ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M'] },
                },
                required: ['symbol'],
            },
        },
        {
            name: 'run_pine_script',
            description: 'MUST USE for every analysis. Write and execute Pine Script v5 on the chart to draw support/resistance lines, trend lines, MA crossovers, buy/sell signals. The user sees your drawings on the chart. Always draw at minimum: support/resistance levels and key moving averages.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    symbol: { type: Type.STRING, description: 'Ticker symbol' },
                    timeframe: { type: Type.STRING, description: 'Timeframe', enum: ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M'] },
                    scripts: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'Array of Pine Script v5 code strings.',
                    },
                },
                required: ['symbol', 'scripts'],
            },
        },
        {
            name: 'take_screenshot',
            description: 'Capture the current chart view as an image.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    caption: { type: Type.STRING, description: 'Caption for the screenshot' },
                },
            },
        },
        {
            name: 'web_search',
            description: 'Search the web for recent news, institutional trading activity (机构买卖/大宗交易), earnings reports (财报), analyst ratings, and any other market information. Use this to provide comprehensive research beyond just technical analysis.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    query: { type: Type.STRING, description: 'Search query. For Chinese stocks, search in Chinese for better results.' },
                },
                required: ['query'],
            },
        },
    ],
}];

const SYSTEM_PROMPT = `You are VibeTrader AI — an institutional-grade trading analysis agent with DIRECT CONTROL over the VibeTrader charting platform.
你是 VibeTrader AI，机构级交易分析AI代理，可以直接控制VibeTrader图表。

**YOUR 7 TOOLS:**
1. **update_chart** — Switch chart to any symbol/timeframe (built-in EMA/MACD/RSI auto-load)
2. **get_stock_data** — Fetch OHLCV candle data
3. **calculate_indicators** — ALL indicators at once: pass ["all"] for sma, ema, rsi, macd, bb, kdj, atr, vwap, obv, williams_r, stochastic, cci, fibonacci, pivot_points, volume
4. **get_fundamentals** — P/E, market cap, revenue, margins, analyst targets (stocks only)
5. **run_pine_script** — Write Pine Script v5 to DRAW on chart: support/resistance lines, trend lines, MA crosses, buy/sell signals
6. **take_screenshot** — Capture chart image
7. **web_search** — Search web for news, 机构买卖/大宗交易, 财报, analyst ratings, institutional flow

**MANDATORY WORKFLOW (follow EVERY TIME):**
1. update_chart(symbol, timeframe) — user sees chart immediately
2. calculate_indicators(symbol, ["all"]) — get ALL 15+ indicators at once
3. get_stock_data(symbol, timeframe, 200) — raw OHLCV data
4. get_fundamentals(symbol) — for stocks: P/E, revenue, 财报 data
5. web_search("[symbol] 最新消息 机构买卖 大宗交易") — for A-shares: search for institutional activity
   web_search("[symbol] latest news institutional trading") — for US stocks
6. run_pine_script — ALWAYS draw on chart:
   - Support & resistance horizontal lines (from Fibonacci/Pivot data)
   - Key moving averages (SMA20, SMA50, SMA200)
   - Buy/sell signal markers if crossovers detected
   - Trend channel lines if applicable
7. Write comprehensive analysis with ALL sections below

**ANALYSIS SECTIONS (include ALL):**
1. 📊 **价格概览** — Current price, day range, period high/low
2. 📈 **趋势分析** — MA alignment (SMA20/50/200), trend direction, trend strength
3. ⚡ **动量指标** — RSI (overbought/oversold), MACD (cross signals), KDJ (golden/dead cross), Stochastic
4. 📉 **波动性** — ATR (average true range), Bollinger Bands (width, position, squeeze)
5. 📦 **成交量** — Volume ratio vs 5/20-day avg, OBV trend, VWAP position
6. 🎯 **关键价位** — Fibonacci levels, Pivot Points (R1-R3, S1-S3), support/resistance
7. 💰 **基本面** (stocks) — P/E, market cap, revenue growth, profit margins, 最新财报
8. 🏛️ **机构动向** — Institutional buying/selling (大宗交易), analyst ratings, recent news
9. 🔮 **综合判断** — Bull/Bear score (1-10), risk level, short/mid/long term outlook

**Pine Script — ALWAYS write and execute this for EVERY analysis:**
\`\`\`
//@version=5
indicator("AI Analysis", overlay=true)
// Moving Averages
plot(ta.sma(close, 20), "SMA20", color=color.blue, linewidth=1)
plot(ta.sma(close, 50), "SMA50", color=color.orange, linewidth=1)
plot(ta.sma(close, 200), "SMA200", color=color.red, linewidth=2)
// Support & Resistance
highest20 = ta.highest(high, 20)
lowest20 = ta.lowest(low, 20)
plot(highest20, "Resistance", color=color.new(color.red, 50), style=plot.style_stepline)
plot(lowest20, "Support", color=color.new(color.green, 50), style=plot.style_stepline)
// Buy/Sell Signals
bull = ta.crossover(ta.sma(close, 20), ta.sma(close, 50))
bear = ta.crossunder(ta.sma(close, 20), ta.sma(close, 50))
plotshape(bull, "Buy", shape.triangleup, location.belowbar, color.green, size=size.small)
plotshape(bear, "Sell", shape.triangledown, location.abovebar, color.red, size=size.small)
\`\`\`

**MARKETS:** US: AAPL | A股: 600519.SS, 002065.SZ | HK: 0700.HK | Crypto: BTCUSDT | Forex: EURUSD=X

**RULES:**
- Match user's language. 用户用中文就用中文。
- Cite actual numbers. Never guess.
- ALWAYS use run_pine_script to draw analysis on chart.
- ALWAYS search for institutional activity and news.
- Risk disclaimer: "这不构成投资建议。" / "Not financial advice."`;

// ═══════════════════════════════════════════════════
// Tool execution
// ═══════════════════════════════════════════════════

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
        case 'get_stock_data': {
            const symbol = args.symbol as string;
            const timeframe = (args.timeframe as string) || '1D';
            const limit = Math.min((args.limit as number) || 100, 500);
            const candles = await getStockData(symbol, timeframe, limit);
            // Return summary + last 30 candles to keep context manageable
            const recent = candles.slice(-30);
            const first = candles[0];
            const last = candles[candles.length - 1];
            // Use reduce instead of Math.max(...spread) to avoid stack overflow on large arrays
            const priceHigh = candles.length ? candles.reduce((m, c) => c.high > m ? c.high : m, candles[0].high) : 0;
            const priceLow = candles.length ? candles.reduce((m, c) => c.low < m ? c.low : m, candles[0].low) : 0;
            return {
                symbol,
                timeframe,
                total_candles: candles.length,
                period: { from: first?.time, to: last?.time },
                latest: last,
                price_range: { high: priceHigh, low: priceLow },
                recent_candles: recent,
            };
        }
        case 'calculate_indicators': {
            const symbol = args.symbol as string;
            const timeframe = (args.timeframe as string) || '1D';
            let indicators = (args.indicators as string[]) || ['sma20', 'rsi', 'macd'];
            // "all" expands to every indicator
            if (indicators.some(i => i.toLowerCase() === 'all')) {
                indicators = ['sma20', 'sma50', 'sma200', 'ema12', 'ema26', 'rsi', 'macd', 'bb', 'kdj', 'atr', 'vwap', 'obv', 'williams_r', 'stochastic', 'cci', 'fibonacci', 'pivot_points', 'volume'];
            }
            const candles = await getStockData(symbol, timeframe, 200);
            const result = calculateIndicators(candles, indicators);
            return {
                symbol,
                timeframe,
                candles_used: candles.length,
                latest_price: candles[candles.length - 1]?.close,
                indicators: result,
            };
        }
        case 'get_fundamentals': {
            const symbol = args.symbol as string;
            try {
                const modules = 'financialData,defaultKeyStatistics,summaryDetail,earningsHistory';
                const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}`;
                const resp = await fetch(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VibeTrader/1.0)' },
                });
                if (!resp.ok) {
                    return { symbol, error: `Yahoo Finance returned ${resp.status}. Fundamentals may not be available for this symbol.` };
                }
                const data = await resp.json() as any;
                const result = data?.quoteSummary?.result?.[0];
                if (!result) return { symbol, error: 'No fundamental data available' };

                const fd = result.financialData || {};
                const ks = result.defaultKeyStatistics || {};
                const sd = result.summaryDetail || {};

                return {
                    symbol,
                    financial_data: {
                        current_price: fd.currentPrice?.raw,
                        target_high_price: fd.targetHighPrice?.raw,
                        target_low_price: fd.targetLowPrice?.raw,
                        target_mean_price: fd.targetMeanPrice?.raw,
                        recommendation: fd.recommendationKey,
                        revenue: fd.totalRevenue?.raw,
                        revenue_growth: fd.revenueGrowth?.raw,
                        gross_margins: fd.grossMargins?.raw,
                        operating_margins: fd.operatingMargins?.raw,
                        profit_margins: fd.profitMargins?.raw,
                        return_on_equity: fd.returnOnEquity?.raw,
                        debt_to_equity: fd.debtToEquity?.raw,
                        free_cashflow: fd.freeCashflow?.raw,
                        earnings_growth: fd.earningsGrowth?.raw,
                    },
                    key_statistics: {
                        pe_trailing: ks.trailingEps?.raw ? (fd.currentPrice?.raw / ks.trailingEps?.raw) : sd.trailingPE?.raw,
                        pe_forward: ks.forwardEps?.raw ? (fd.currentPrice?.raw / ks.forwardEps?.raw) : sd.forwardPE?.raw,
                        peg_ratio: ks.pegRatio?.raw,
                        price_to_book: ks.priceToBook?.raw,
                        market_cap: sd.marketCap?.raw,
                        enterprise_value: ks.enterpriseValue?.raw,
                        beta: ks.beta?.raw,
                        '52w_high': sd.fiftyTwoWeekHigh?.raw,
                        '52w_low': sd.fiftyTwoWeekLow?.raw,
                        dividend_yield: sd.dividendYield?.raw,
                    },
                };
            } catch (err) {
                console.error(`Error fetching fundamentals for ${symbol}:`, err);
                return { symbol, error: 'Failed to fetch fundamental data' };
            }
        }
        default:
            return { error: `Unknown tool: ${name}` };
    }
}

// ═══════════════════════════════════════════════════
// Chat endpoint
// ═══════════════════════════════════════════════════

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

app.post('/api/chat', async (req, res) => {
    try {
        const { messages, context, model: requestedModel } = req.body as {
            messages: ChatMessage[];
            context?: { ticker?: string; timeframe?: string; klineData?: Candle[] };
            model?: string;
        };

        if (!messages || messages.length === 0) {
            res.status(400).json({ error: 'messages is required' });
            return;
        }

        // Allowed models whitelist
        const ALLOWED_MODELS: Record<string, string> = {
            'gemini-3-flash': 'gemini-3-flash-preview',
            'gemini-3-pro': 'gemini-3-pro-preview',
            'gemini-3.1-pro': 'gemini-3.1-pro-preview',
        };
        const modelId = (requestedModel && ALLOWED_MODELS[requestedModel]) || 'gemini-3-flash-preview';
        console.log(`🤖 Using model: ${modelId}`);

        // Set up SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        // Build conversation history for Gemini
        const geminiHistory = messages.slice(0, -1).map(msg => ({
            role: msg.role === 'assistant' ? 'model' as const : 'user' as const,
            parts: [{ text: msg.content }],
        }));

        // Build the current user message with chart context
        const lastMsg = messages[messages.length - 1];
        let userContent = lastMsg.content;

        if (context?.ticker) {
            userContent += `\n\n[Current Chart Context: ${context.ticker} on ${context.timeframe || '1D'} timeframe`;
            if (context.klineData && context.klineData.length > 0) {
                const last = context.klineData[context.klineData.length - 1];
                userContent += `, Latest: O:${last.open} H:${last.high} L:${last.low} C:${last.close} V:${last.volume}`;
            }
            userContent += ']';
        }

        const chat = ai.chats.create({
            model: modelId,
            history: geminiHistory,
            config: {
                systemInstruction: SYSTEM_PROMPT,
                tools: tools,
            },
        });

        // Send message and handle tool calls in a loop
        let response = await chat.sendMessage({ message: userContent });

        const MAX_TOOL_ROUNDS = 5;
        let round = 0;

        while (round < MAX_TOOL_ROUNDS) {
            const candidate = response.candidates?.[0];
            if (!candidate?.content?.parts) break;

            const functionCalls = candidate.content.parts.filter(p => p.functionCall);
            if (functionCalls.length === 0) break;

            // Execute tool calls SEQUENTIALLY so SSE events stream in real-time
            const toolResponses: { functionResponse: { name: string; response: unknown } }[] = [];

            for (const part of functionCalls) {
                const fc = part.functionCall!;
                const toolArgs = fc.args as Record<string, unknown>;
                console.log(`🔧 Tool call: ${fc.name}(${JSON.stringify(toolArgs)})`);

                // ── Emit real-time tool_use event so user sees what AI is doing ──
                const toolLabel: Record<string, string> = {
                    'update_chart': `📊 Switching chart to ${toolArgs.symbol || ''} (${toolArgs.timeframe || '1D'})`,
                    'get_stock_data': `📈 Fetching price data for ${toolArgs.symbol || ''}...`,
                    'calculate_indicators': `🔢 Calculating ${(toolArgs.indicators as string[])?.includes?.('all') ? 'ALL' : (toolArgs.indicators as string[])?.length || 0} indicators...`,
                    'get_fundamentals': `💰 Fetching fundamentals for ${toolArgs.symbol || ''}...`,
                    'run_pine_script': `🎨 Drawing analysis on chart for ${toolArgs.symbol || ''}...`,
                    'take_screenshot': `📷 Capturing chart screenshot...`,
                    'web_search': `🔍 Searching: ${toolArgs.query || ''}`,
                };
                res.write(`data: ${JSON.stringify({
                    type: 'tool_use',
                    tool: fc.name,
                    label: toolLabel[fc.name] || `🔧 Using ${fc.name}...`,
                    args: toolArgs,
                })}\n\n`);
                // Small delay to force SSE flush so events appear one-by-one
                await new Promise(r => setTimeout(r, 50));

                // ── VibeTrader front-end tools: emit SSE events directly ──

                if (fc.name === 'update_chart') {
                    const args = toolArgs as { symbol: string; timeframe?: string };
                    res.write(`data: ${JSON.stringify({
                        type: 'chart_update',
                        symbol: args.symbol.toUpperCase(),
                        timeframe: args.timeframe || '1D',
                    })}\n\n`);
                    toolResponses.push({
                        functionResponse: {
                            name: fc.name,
                            response: { output: { success: true, message: `Chart updated to ${args.symbol} ${args.timeframe || '1D'}. The chart now shows EMA, MACD, RSI automatically.` } }
                        }
                    });
                    continue;
                }

                if (fc.name === 'run_pine_script') {
                    const args = toolArgs as { symbol: string; timeframe?: string; scripts: string[] };
                    res.write(`data: ${JSON.stringify({
                        type: 'run_pine_script',
                        symbol: args.symbol.toUpperCase(),
                        timeframe: args.timeframe || '1D',
                        scripts: args.scripts,
                    })}\n\n`);
                    toolResponses.push({
                        functionResponse: {
                            name: fc.name,
                            response: { output: { success: true, message: `Pine Script drawn on chart for ${args.symbol}. User can see support/resistance lines, MAs, and signals.` } }
                        }
                    });
                    continue;
                }

                if (fc.name === 'take_screenshot') {
                    const args = (toolArgs as { caption?: string }) || {};
                    res.write(`data: ${JSON.stringify({
                        type: 'take_screenshot',
                        caption: args.caption || 'Chart screenshot',
                    })}\n\n`);
                    toolResponses.push({
                        functionResponse: {
                            name: fc.name,
                            response: { output: { success: true, message: 'Screenshot captured.' } }
                        }
                    });
                    continue;
                }

                if (fc.name === 'web_search') {
                    const query = (toolArgs.query as string) || '';
                    try {
                        const searchUrl = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&num=5&key=${process.env.GOOGLE_SEARCH_KEY || ''}&cx=${process.env.GOOGLE_SEARCH_CX || ''}`;
                        const hasSearchKey = process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX;
                        let searchResults: string;
                        if (hasSearchKey) {
                            const searchResp = await fetch(searchUrl);
                            const searchData = await searchResp.json() as any;
                            const items = searchData.items?.slice(0, 5) || [];
                            searchResults = items.map((item: any) => `**${item.title}**\n${item.snippet}\nURL: ${item.link}`).join('\n\n') || 'No results found.';
                        } else {
                            searchResults = `Web search for "${query}" — Note: To enable real web search, set GOOGLE_SEARCH_KEY and GOOGLE_SEARCH_CX environment variables. For now, please use your training knowledge to discuss this topic.`;
                        }
                        toolResponses.push({
                            functionResponse: {
                                name: fc.name,
                                response: { output: { query, results: searchResults } }
                            }
                        });
                    } catch (err) {
                        toolResponses.push({
                            functionResponse: {
                                name: fc.name,
                                response: { output: { query, error: 'Search failed', results: `Unable to search for "${query}". Please use your training knowledge.` } }
                            }
                        });
                    }
                    continue;
                }

                // ── Data tools: fetch real data from Yahoo/Binance ──
                const result = await executeTool(fc.name, toolArgs);
                toolResponses.push({ functionResponse: { name: fc.name, response: result } });
            }



            // Send tool results back as Part[] directly (NOT wrapped in a Content object)
            // The SDK's sendMessage expects: message: string | Part[]
            // Each Part with a functionResponse field is the correct format
            response = await chat.sendMessage({
                message: toolResponses.map(tr => ({
                    functionResponse: {
                        name: tr.functionResponse.name,
                        response: { output: tr.functionResponse.response },
                    }
                }))
            });
            round++;
        }

        // Extract final text and stream it
        const finalText = response.candidates?.[0]?.content?.parts
            ?.filter(p => p.text)
            ?.map(p => p.text)
            ?.join('') || 'I was unable to generate a response. Please try again.';

        // Stream the response in chunks for a typing effect
        const chunkSize = 20;
        for (let i = 0; i < finalText.length; i += chunkSize) {
            const chunk = finalText.slice(i, i + chunkSize);
            res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
            // Small delay for typing effect
            await new Promise(r => setTimeout(r, 15));
        }

        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();

    } catch (error: any) {
        console.error('Chat error:', error);
        // If headers already sent, send error via SSE
        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({ type: 'error', content: error.message || 'Internal server error' })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error: error.message || 'Internal server error' });
        }
    }
});

// Health check
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', model: 'gemini-3-flash-preview' });
});

// SPA fallback — serve index.html for all non-API routes (React Router)
app.get('*', (_req, res) => {
    const indexPath = join(__dirname, '..', 'public', 'index.html');
    if (existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Frontend not found. Please ensure the build process completed successfully.');
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 VibeTrader running on port ${PORT}`);
    console.log(`   GET  /            — Frontend`);
    console.log(`   POST /api/chat    — Chat with Gemini`);
    console.log(`   GET  /api/health  — Health check`);
});
