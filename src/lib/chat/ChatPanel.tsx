import { useState, useRef, useEffect, useCallback, type FormEvent, type ChangeEvent, type KeyboardEvent } from 'react';
import './ChatPanel.css';

// ═══════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

export interface ChartContext {
    ticker: string;
    timeframe: string;
    klineData?: Array<{
        time: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>;
}

interface ChatPanelProps {
    chartContext?: ChartContext;
    apiUrl?: string;
    onChartUpdate?: (symbol: string, timeframe: string) => void;
    onRunPineScript?: (symbol: string, timeframe: string, scripts: string[]) => void;
    onTakeScreenshot?: (caption: string) => void;
}

// ═══════════════════════════════════════════════════
// Simple Markdown → HTML renderer
// ═══════════════════════════════════════════════════

function renderMarkdown(text: string): string {
    let html = text;

    // Protect code blocks
    const codeBlocks: string[] = [];
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
        codeBlocks.push(`<pre><code class="lang-${lang}">${escapeHtml(code)}</code></pre>`);
        return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
    });

    // Tables
    html = html.replace(/(?:^|\n)(\|.+\|)\n(\|[-: |]+\|)\n((?:\|.+\|\n?)+)/gm, (_match, header: string, _sep, body: string) => {
        const headers = header.split('|').filter((c: string) => c.trim()).map((c: string) => `<th>${c.trim()}</th>`).join('');
        const rows = body.trim().split('\n').map((row: string) => {
            const cells = row.split('|').filter((c: string) => c.trim()).map((c: string) => `<td>${c.trim()}</td>`).join('');
            return `<tr>${cells}</tr>`;
        }).join('');
        return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    });

    // Headers
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // HR
    html = html.replace(/^---$/gm, '<hr/>');

    // Blockquotes
    html = html.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

    // Bold + italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Unordered lists
    html = html.replace(/((?:^[-*•]\s.+$\n?)+)/gm, (match) => {
        const items = match.trim().split('\n')
            .map(line => line.replace(/^[-*•]\s/, '').trim())
            .filter(Boolean)
            .map(item => `<li>${item}</li>`)
            .join('');
        return `<ul>${items}</ul>`;
    });

    // Ordered lists
    html = html.replace(/((?:^\d+\.\s.+$\n?)+)/gm, (match) => {
        const items = match.trim().split('\n')
            .map(line => line.replace(/^\d+\.\s/, '').trim())
            .filter(Boolean)
            .map(item => `<li>${item}</li>`)
            .join('');
        return `<ol>${items}</ol>`;
    });

    // Paragraphs — wrap remaining loose text lines
    html = html.replace(/^(?!<[a-z/]|%%CODEBLOCK)((?!<\/)[^\n]+)$/gm, '<p>$1</p>');
    html = html.replace(/<p>\s*<\/p>/g, '');

    // Restore code blocks
    html = html.replace(/%%CODEBLOCK_(\d+)%%/g, (_, idx) => codeBlocks[parseInt(idx)]);

    return html;
}

function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════════════
// Suggestion chips (matching reference image: 帮助, 继续, 更多指标, 买卖信号, 交易计划)
// ═══════════════════════════════════════════════════

const SUGGESTIONS = [
    { label: "帮助", labelEn: "Help", icon: "❓", prompt: "What can you help me with?" },
    { label: "继续", labelEn: "Continue", icon: "▶️", prompt: "Continue the previous analysis" },
    { label: "更多指标", labelEn: "More Indicators", icon: "📊", prompt: "Show me more technical indicators" },
    { label: "买卖信号", labelEn: "Buy/Sell Signals", icon: "🔔", prompt: "Analyze buy and sell signals" },
    { label: "交易计划", labelEn: "Trading Plan", icon: "📋", prompt: "Help me create a trading plan" },
];

// ═══════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════

export default function ChatPanel({ chartContext, apiUrl, onChartUpdate, onRunPineScript, onTakeScreenshot }: ChatPanelProps) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isOpen, setIsOpen] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedModel, setSelectedModel] = useState('gemini-3-flash');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // Use passed apiUrl, or Vite env var, or fallback to relative (for local dev proxy)
    const baseUrl = apiUrl || import.meta.env.VITE_API_URL || '';

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Auto-resize textarea
    const handleInputChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
    }, []);

    // ── Send message ──
    const sendMessage = useCallback(async (content: string) => {
        if (!content.trim() || isLoading) return;
        setError(null);

        const userMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            content: content.trim(),
            timestamp: Date.now(),
        };

        const updatedMessages = [...messages, userMsg];
        setMessages(updatedMessages);
        setInput('');
        setIsLoading(true);
        if (inputRef.current) inputRef.current.style.height = 'auto';

        // ── Client-side ticker detection: update chart IMMEDIATELY ──
        const tickerMatch = content.match(/\b([A-Z]{1,5}(?:USDT|USD)?|\d{6}\.(SZ|SS|SH)|\d{4,5}\.HK|\^[A-Z]+|[A-Z]{3,6}=X)\b/i);
        if (tickerMatch && onChartUpdate) {
            const detectedTicker = tickerMatch[0].toUpperCase();
            console.log(`⚡ Client-side ticker detected: ${detectedTicker} — updating chart immediately`);
            onChartUpdate(detectedTicker, '1D');
        }

        try {
            const resp = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: updatedMessages.map(m => ({ role: m.role, content: m.content })),
                    model: selectedModel,
                    context: chartContext ? {
                        ticker: chartContext.ticker,
                        timeframe: chartContext.timeframe,
                        klineData: chartContext.klineData?.slice(-10),
                    } : undefined,
                }),
            });

            if (!resp.ok) throw new Error(`Server error: ${resp.status}`);

            const assistantMsg: ChatMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
            };
            setMessages(prev => [...prev, assistantMsg]);

            // Read SSE stream
            const reader = resp.body?.getReader();
            const decoder = new TextDecoder();

            if (reader) {
                let buffer = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.slice(6));
                                if (data.type === 'chunk') {
                                    assistantMsg.content += data.content;
                                    setMessages(prev => {
                                        const updated = [...prev];
                                        updated[updated.length - 1] = { ...assistantMsg };
                                        return updated;
                                    });
                                } else if (data.type === 'chart_update') {
                                    // AI is telling us to switch the chart
                                    const symbol = data.symbol as string;
                                    const timeframe = (data.timeframe as string) || '1D';
                                    onChartUpdate?.(symbol, timeframe);
                                    assistantMsg.content += `\n> 📊 **Switching chart to ${symbol} (${timeframe})**\n`;
                                    setMessages(prev => {
                                        const updated = [...prev];
                                        updated[updated.length - 1] = { ...assistantMsg };
                                        return updated;
                                    });
                                } else if (data.type === 'run_pine_script') {
                                    const symbol = data.symbol as string;
                                    const timeframe = (data.timeframe as string) || '1D';
                                    const scripts = data.scripts as string[];
                                    onRunPineScript?.(symbol, timeframe, scripts);
                                    assistantMsg.content += `\n> 🎨 **Drawing custom indicators on ${symbol} chart**\n`;
                                    setMessages(prev => {
                                        const updated = [...prev];
                                        updated[updated.length - 1] = { ...assistantMsg };
                                        return updated;
                                    });
                                } else if (data.type === 'take_screenshot') {
                                    onTakeScreenshot?.(data.caption as string);
                                    assistantMsg.content += `\n> 📷 **Screenshot captured**\n`;
                                    setMessages(prev => {
                                        const updated = [...prev];
                                        updated[updated.length - 1] = { ...assistantMsg };
                                        return updated;
                                    });
                                } else if (data.type === 'tool_use') {
                                    // Real-time tool visibility — show what the AI agent is doing
                                    assistantMsg.content += `\n> ${data.label}\n`;
                                    setMessages(prev => {
                                        const updated = [...prev];
                                        updated[updated.length - 1] = { ...assistantMsg };
                                        return updated;
                                    });
                                } else if (data.type === 'error') {
                                    setError(data.content);
                                }
                            } catch { /* skip malformed */ }
                        }
                    }
                }
            }
        } catch (err: any) {
            setError(err.message || 'Failed to connect to AI server');
        } finally {
            setIsLoading(false);
        }
    }, [messages, isLoading, baseUrl, chartContext, selectedModel, onChartUpdate, onRunPineScript, onTakeScreenshot]);

    const handleSubmit = useCallback((e: FormEvent) => {
        e.preventDefault();
        sendMessage(input);
    }, [input, sendMessage]);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(input);
        }
    }, [input, sendMessage]);

    const handleSuggestion = useCallback((prompt: string) => {
        const ticker = chartContext?.ticker || 'the current stock';
        const tf = chartContext?.timeframe || '1D';
        sendMessage(`${prompt} for ${ticker} on ${tf} timeframe`);
    }, [chartContext, sendMessage]);

    const clearChat = useCallback(() => {
        setMessages([]);
        setError(null);
    }, []);

    // ───────────────────────────────────────────────
    // Welcome message — Bilingual (Chinese first, then English)
    // Matching reference image layout exactly
    // ───────────────────────────────────────────────

    const welcomeContent = (
        <div className="chat-welcome">
            {/* ── Chinese Version ── */}
            <p>
                我是 VibeTrader AI，由 VibeTrader 开发的机构级技术分析专家。你可以向我询问关于股票、加密货币、外汇和指数的市场分析、技术指标应用以及交易策略评估。
            </p>
            <p>以下是你可以向我提问的几个主要方向：</p>

            <div className="chat-welcome-section">1. 特定资产的市场分析（股票、加密货币、外汇、指数）</div>
            <p>你可以让我分析任何资产的当前市场结构、趋势以及支撑/阻力位。</p>
            <ul>
                <li>示例："请分析苹果（AAPL）日线图的走势。"</li>
                <li>示例："比特币（BTC-USD）在4小时级别上的当前趋势是什么？"</li>
                <li>示例："帮我看看腾讯控股（0700.HK）的周线图。"</li>
            </ul>

            <div className="chat-welcome-section">2. 应用技术指标（使用 Pine Script）</div>
            <p>我可以编写并运行自定义的 Pine Script 技术指标，将其叠加在图表上以提供更深入的见解。</p>
            <ul>
                <li>示例："在 NVDA 图表上添加50日和200日移动平均线（MA），看看是否有金叉或死叉。"</li>
                <li>示例："在以太坊（ETH-USD）1小时图上运行 RSI 和 MACD 指标，并分析其动能。"</li>
                <li>示例："在标普500指数（^GSPC）日线图上绘制布林带（Bollinger Bands）。"</li>
            </ul>

            <div className="chat-welcome-section">3. 多时间级别分析</div>
            <p>我可以在不同的时间级别（例如15分钟、1小时、4小时、日线1D、周线1W）之间切换，为你提供自上而下的市场视角。</p>
            <ul>
                <li>示例："先看看特斯拉（TSLA）的日线图确定宏观趋势，然后切换到15分钟图寻找短期的支撑和阻力位。"</li>
            </ul>

            <div className="chat-welcome-section">4. K线形态与价格行为识别</div>
            <p>我可以通过截取并查看实时图表，识别关键的K线形态（如吞没形态、十字星等）和价格行为设置。</p>
            <ul>
                <li>示例："欧元兑美元（EURUSD=X）日线图上是否有任何看涨反转形态？"</li>
                <li>示例："近期的K线（红涨绿跌）表现出的是买方还是卖方压力？"</li>
            </ul>

            <p><strong>如何开始：</strong>只需告诉我你想要分析的交易品种代码（需符合雅虎财经格式，例如：TSLA, BTC-USD, 0700.HK, 600519.SS 等），以及你希望关注的技术指标或时间级别，我就会为你调出图表并进行深度解析！</p>

            <hr className="chat-welcome-divider" />

            {/* ── English Version ── */}
            <p>
                I am VibeTrader AI, an institutional-grade technical analysis expert developed by VibeTrader. You can ask me about market analysis, technical indicator application, and trading strategy evaluation for stocks, crypto, forex, and indices.
            </p>

            <div className="chat-welcome-section">1. Market Analysis (Stocks, Crypto, Forex, Indices)</div>
            <p>I can analyze any asset's current market structure, trends, and support/resistance levels.</p>
            <ul>
                <li>Example: "Analyze AAPL's daily chart trend."</li>
                <li>Example: "What is BTC-USD's trend on the 4h timeframe?"</li>
                <li>Example: "Show me Tencent (0700.HK) weekly chart."</li>
            </ul>

            <div className="chat-welcome-section">2. Technical Indicators</div>
            <p>I can calculate and interpret SMA, EMA, RSI, MACD, Bollinger Bands, and overlay them on charts for deeper insights.</p>
            <ul>
                <li>Example: "Add 50 and 200 day SMA on NVDA — is there a golden cross?"</li>
                <li>Example: "Run RSI and MACD on ETH-USD 1h chart and analyze momentum."</li>
                <li>Example: "Draw Bollinger Bands on S&P 500 (^GSPC) daily chart."</li>
            </ul>

            <div className="chat-welcome-section">3. Multi-Timeframe Analysis</div>
            <p>I can switch between timeframes (1m, 5m, 15m, 1h, 4h, 1D, 1W) to give you a top-down market perspective.</p>

            <div className="chat-welcome-section">4. Candlestick Patterns & Price Action</div>
            <p>I can identify key candlestick patterns (doji, engulfing, hammer) and price action setups by reading live chart data.</p>

            <p><strong>How to start:</strong> Just tell me the ticker symbol (Yahoo Finance format, e.g., TSLA, BTC-USD, 0700.HK, 600519.SS) and the technical indicators or timeframe you'd like, and I'll pull up the chart and provide a deep analysis!</p>

            {chartContext?.ticker && (
                <div className="context-badge">
                    📊 当前查看 / Currently viewing: <strong>&nbsp;{chartContext.ticker}</strong>&nbsp; ({chartContext.timeframe})
                </div>
            )}
        </div>
    );

    // ───────────────────────────────────────────────
    // Render
    // ───────────────────────────────────────────────

    return (
        <>
            {/* Floating toggle — 能问啥? / What can I ask? */}
            <button
                className="chat-toggle-btn"
                onClick={() => setIsOpen(prev => !prev)}
                title={isOpen ? 'Close AI Chat' : 'Open AI Chat'}
            >
                {isOpen ? '✕' : '能问啥?'}
            </button>

            {/* Panel */}
            <div className={`chat-panel ${isOpen ? '' : 'collapsed'}`}>
                {/* Header */}
                <div className="chat-header">
                    <div className="chat-header-title">
                        <span className="dot" />
                        VibeTrader AI
                        <span className="chat-header-badge">Gemini</span>
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <select
                            value={selectedModel}
                            onChange={(e) => setSelectedModel(e.target.value)}
                            style={{
                                background: 'rgba(255,255,255,0.1)',
                                color: 'inherit',
                                border: '1px solid rgba(255,255,255,0.2)',
                                borderRadius: 4,
                                padding: '2px 4px',
                                fontSize: 11,
                                cursor: 'pointer',
                                outline: 'none',
                            }}
                            title="Switch AI model"
                        >
                            <option value="gemini-3-flash" style={{ background: '#1a1a2e' }}>⚡ Flash</option>
                            <option value="gemini-3-pro" style={{ background: '#1a1a2e' }}>🧠 3 Pro</option>
                            <option value="gemini-3.1-pro" style={{ background: '#1a1a2e' }}>🚀 3.1 Pro</option>
                        </select>
                        {messages.length > 0 && (
                            <button className="chat-header-close" onClick={clearChat} title="Clear chat">
                                🗑
                            </button>
                        )}
                        <button className="chat-header-close" onClick={() => setIsOpen(false)} title="Close">
                            ✕
                        </button>
                    </div>
                </div>

                {/* Messages */}
                <div className="chat-messages">
                    {messages.length === 0 && welcomeContent}

                    {messages.map(msg => (
                        <div key={msg.id} className={`chat-msg ${msg.role}`}>
                            {msg.role === 'user' ? (
                                msg.content
                            ) : (
                                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content || '...') }} />
                            )}
                        </div>
                    ))}

                    {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
                        <div className="typing-indicator">
                            <span /><span /><span />
                        </div>
                    )}

                    {error && <div className="chat-error">⚠️ {error}</div>}
                    <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <form className="chat-input-area" onSubmit={handleSubmit}>
                    <textarea
                        ref={inputRef}
                        className="chat-input"
                        placeholder="Ask AI"
                        value={input}
                        onChange={handleInputChange}
                        onKeyDown={handleKeyDown}
                        rows={1}
                        disabled={isLoading}
                    />
                    {/* Icon toolbar — matching reference image */}
                    <div className="chat-input-icons">
                        <span className="chat-icon-badge">{selectedModel === 'gemini-3-flash' ? 'Flash' : selectedModel === 'gemini-3-pro' ? 'Pro' : '3.1 Pro'}</span>
                        <button type="button" className="chat-icon-btn" onClick={clearChat} title="清除 / Clear">🔄</button>
                        <button type="button" className="chat-icon-btn" onClick={clearChat} title="清空 / Reset">🗑️</button>
                        <button type="submit" className="chat-send-btn" disabled={!input.trim() || isLoading} title="发送 / Send">➤</button>
                    </div>
                </form>

                {/* Suggestion Chips — 帮助, 继续, 更多指标, 买卖信号, 交易计划 */}
                <div className="chat-suggestions">
                    {SUGGESTIONS.map(s => (
                        <button key={s.label} className="chat-chip" onClick={() => handleSuggestion(s.prompt)} disabled={isLoading}>
                            {s.label}
                        </button>
                    ))}
                    <button className="chat-chip chat-chip-more" disabled={isLoading} onClick={() => handleSuggestion('Show me what else you can do')}>…</button>
                </div>
            </div>
        </>
    );
}
