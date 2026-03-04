/**
 * ChatPage — Standalone page layout that composes VibeTrader chart + AI Chat panel.
 * 
 * This is the bridge between the AI chat and VibeTrader chart.
 * When Gemini calls tools (update_chart, run_pine_script, take_screenshot),
 * this component receives the callbacks and applies them to the chart.
 * 
 * Access via: /chat route
 */
import { useRef, useState, useEffect, useCallback } from 'react';
import { style } from '@react-spectrum/s2/style' with {type: 'macro'};
import KlineViewContainer from '../charting/view/KlineViewContainer';
import ChatPanel, { type ChartContext } from './ChatPanel';

type ChatPageProps = {
    toggleColorTheme?: () => void
    colorTheme?: 'light' | 'dark'
}

const ChatPage = (props: ChatPageProps) => {
    const chartRef = useRef<KlineViewContainer | null>(null);
    const [chartContext, setChartContext] = useState<ChartContext | undefined>(undefined);

    // Callback ref to capture the KlineViewContainer class instance
    const setChartRef = useCallback((node: KlineViewContainer | null) => {
        chartRef.current = node;
    }, []);

    // Poll chart for current context (ticker, timeframe, recent klines)
    useEffect(() => {
        const interval = setInterval(() => {
            const chart = chartRef.current;
            if (chart && chart.ticker && chart.kvar) {
                try {
                    const klineArray = chart.kvar.toArray();
                    const recentKlines = klineArray
                        .slice(-10)
                        .filter(k => k !== undefined)
                        .map(k => ({
                            time: new Date(k.time).toISOString(),
                            open: k.open,
                            high: k.high,
                            low: k.low,
                            close: k.close,
                            volume: k.volume,
                        }));

                    setChartContext(prev => {
                        if (prev?.ticker === chart.ticker && prev?.timeframe === chart.tframe?.shortName) {
                            return prev;
                        }
                        return {
                            ticker: chart.ticker,
                            timeframe: chart.tframe?.shortName || '1D',
                            klineData: recentKlines,
                        };
                    });
                } catch {
                    // chart may not be fully initialized yet
                }
            }
        }, 2000);

        return () => clearInterval(interval);
    }, []);

    // ── AI Tool: update_chart ──
    // Switch the VibeTrader chart to a new symbol + timeframe
    const handleChartUpdate = useCallback((symbol: string, timeframe: string) => {
        const chart = chartRef.current;
        if (!chart) {
            console.warn('ChatPage: chart ref not available for update_chart');
            return;
        }
        console.log(`🔄 AI → update_chart: ${symbol} (${timeframe})`);
        // Reset any AI scripts so the chart loads with default indicators (EMA, MACD, RSI)
        chart.scripts = undefined;
        chart.analyze(symbol, timeframe).catch((err: unknown) => {
            console.error('Failed to update chart from AI:', err);
        });
    }, []);

    // ── AI Tool: run_pine_script ──
    // Execute Pine Script on the chart, drawing custom indicators/signals
    // IMPORTANT: Merge default indicators (EMA, MACD, RSI) with AI scripts
    const handleRunPineScript = useCallback((symbol: string, timeframe: string, scripts: string[]) => {
        const chart = chartRef.current;
        if (!chart) {
            console.warn('ChatPage: chart ref not available for run_pine_script');
            return;
        }
        console.log(`🎨 AI → run_pine_script: ${scripts.length} script(s) on ${symbol} (${timeframe})`);

        // Get the default indicator scripts (ema, macd, rsi) so they aren't lost
        try {
            const defaultInds = chart.getSelectedIncicators?.() || [];
            const defaultScriptCodes = defaultInds
                .map((s: { script: string }) => s.script)
                .filter(Boolean);
            // Merge: default indicators FIRST, then AI analysis scripts on top
            const mergedScripts = [...defaultScriptCodes, ...scripts];
            chart.analyze(symbol, timeframe, mergedScripts).catch((err: unknown) => {
                console.error('Failed to run Pine Script from AI:', err);
            });
        } catch {
            // Fallback: just run AI scripts if defaults can't be fetched
            chart.analyze(symbol, timeframe, scripts).catch((err: unknown) => {
                console.error('Failed to run Pine Script from AI:', err);
            });
        }
    }, []);

    // ── AI Tool: take_screenshot ──
    // Capture the current chart as an image
    const handleTakeScreenshot = useCallback((caption: string) => {
        const chart = chartRef.current;
        if (!chart) {
            console.warn('ChatPage: chart ref not available for take_screenshot');
            return;
        }
        console.log(`📷 AI → take_screenshot: "${caption}"`);
        chart.takeScreenshot().then((canvas: HTMLCanvasElement) => {
            // Open the screenshot in the VibeTrader screenshot modal
            chart.setState({ screenshot: canvas });
        }).catch((err: unknown) => {
            console.error('Failed to take screenshot from AI:', err);
        });
    }, []);

    return (
        <div className={style({ display: "flex" })} style={{ width: '100%', height: '100vh', overflow: 'hidden' }}>
            {/* Chart takes all remaining space after chat panel */}
            <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
                <KlineViewContainer
                    ref={setChartRef as any}
                    toggleColorTheme={props.toggleColorTheme}
                    colorTheme={props.colorTheme}
                    chartOnly={false}
                />
            </div>
            <ChatPanel
                chartContext={chartContext}
                onChartUpdate={handleChartUpdate}
                onRunPineScript={handleRunPineScript}
                onTakeScreenshot={handleTakeScreenshot}
            />
        </div>
    );
};

export default ChatPage;
