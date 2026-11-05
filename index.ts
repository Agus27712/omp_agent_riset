/**
 * tokocrypto-direct — OMP 18.x extension
 *
 * Fokus utama:
 * - fetch market data langsung dari Tokocrypto public API
 * - hitung indikator lokal (EMA/RSI/VWAP/ATR)
 * - support paper trading dan jurnal per pair
 * - live execution tetap OFF by default
 * - siap untuk monitoring 24/7 saat agent berjalan di OMP 18.x
 *
 * Catatan penting:
 * - Semua signal adalah advisory only
 * - Paper trade diaktifkan secara eksplisit
 * - Real trade harus dikonfirmasi secara manual, tidak otomatis
 * - Jurnal trade dibuat untuk setiap eksekusi dan dikelompokkan per pasangan (pair)
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const BASE_OPEN = "https://www.tokocrypto.com/open/v1";
const BASE_BINANCE_STYLE = "https://www.tokocrypto.com/api/v3";

type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type SetupHint = {
  name: string;
  active: boolean;
  confidence: number;
  note: string;
};

type PositionSide = "BUY" | "SELL";

type Position = {
  symbol: string;
  side: PositionSide;
  quantity: number;
  avgPrice: number;
  openedAt: string;
  lastUpdatedAt: string;
  realizedPnl: number;
  unrealizedPnl: number;
};

type TradeJournalEntry = {
  tradeId: string;
  symbol: string;
  pair: string;
  side: PositionSide;
  type: "OPEN" | "CLOSE" | "ADJUST" | "FEE" | "PNL" | "DECISION";
  qty: number;
  price: number;
  amountUsd: number;
  ts: string;
  notes?: string;
  analysis?: string;
  decision?: "BUY" | "SELL" | "HOLD" | "WAIT";
};

type PairSummary = {
  pair: string;
  trades: number;
  wins: number;
  losses: number;
  totalPnlUsd: number;
  lastUpdatedAt: string;
};

type RiskConfig = {
  maxPositions: number;
  maxExposurePercent: number;
  maxDailyLossPercent: number;
  feeBps: number;
  slippageBps: number;
  maxOrderNotionalUsd: number;
  enabled: boolean;
};

type PaperState = {
  version: number;
  equityUsd: number;
  cashUsd: number;
  positions: Position[];
  journal: TradeJournalEntry[];
  pairSummaries: Record<string, PairSummary>;
  createdAt: string;
  updatedAt: string;
  config: RiskConfig;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(symbol: string): string {
  return symbol
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[\/\\]/g, "_");
}

function pairFromSymbol(symbol: string): string {
  const s = normalizeSymbol(symbol);
  return s.includes("_") ? s : `${s}_USDT`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeKline(raw: unknown): Candle {
  if (Array.isArray(raw)) {
    return {
      openTime: safeNumber(raw[0]),
      open: safeNumber(raw[1]),
      high: safeNumber(raw[2]),
      low: safeNumber(raw[3]),
      close: safeNumber(raw[4]),
      volume: safeNumber(raw[5]),
    };
  }

  if (raw && typeof raw === "object") {
    const row = raw as Record<string, unknown>;
    return {
      openTime: safeNumber(row.openTime ?? row.open_time ?? row.time),
      open: safeNumber(row.open),
      high: safeNumber(row.high),
      low: safeNumber(row.low),
      close: safeNumber(row.close),
      volume: safeNumber(row.volume),
    };
  }

  throw new Error(`Format candle tidak valid: ${String(raw)}`);
}

function extractKlineArray(payload: unknown): Candle[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeKline);
  }

  if (payload && typeof payload === "object") {
    const data = payload as Record<string, unknown>;
    const candidates = [data.data, data.result, data.klines, data.candles, data.rows];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate.map(normalizeKline);
      }
    }
  }

  throw new Error("Payload Tokocrypto tidak berisi array candle yang valid");
}

function buildRangeQuery(startTime?: number, endTime?: number): string {
  const q: string[] = [];
  if (typeof startTime === "number" && Number.isFinite(startTime)) q.push(`&startTime=${startTime}`);
  if (typeof endTime === "number" && Number.isFinite(endTime)) q.push(`&endTime=${endTime}`);
  return q.join("");
}

async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
  startTime?: number,
  endTime?: number
): Promise<Candle[]> {
  const normalizedSymbol = normalizeSymbol(symbol);
  const range = buildRangeQuery(startTime, endTime);

  const attempts = [
    `${BASE_OPEN}/market/klines?symbol=${normalizedSymbol}&interval=${interval}&limit=${limit}${range}`,
    `${BASE_BINANCE_STYLE}/klines?symbol=${normalizedSymbol.replace(/_/g, "")}&interval=${interval}&limit=${limit}${range}`,
  ];

  let lastErr: unknown = null;
  for (const url of attempts) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const list = extractKlineArray(payload);
      if (!list.length) throw new Error("payload kosong");
      return list;
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(`Gagal fetch klines Tokocrypto untuk ${normalizedSymbol}: ${String(lastErr)}`);
}

async function fetchLatestPrice(symbol: string, interval = "1m", limit = 20): Promise<number> {
  const candles = await fetchKlines(symbol, interval, limit);
  if (!candles.length) throw new Error(`Tidak ada candle untuk ${symbol}`);
  const last = candles[candles.length - 1];
  return Number(last.close || 0);
}

function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  if (!values.length) return out;

  const k = 2 / (period + 1);
  let prev: number | undefined;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = prev === undefined ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(values: number[], period = 14): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }

  gain /= period;
  loss /= period;

  if (loss === 0) out[period] = gain === 0 ? 50 : 100;
  else out[period] = 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;

    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;

    if (loss === 0) out[i] = gain === 0 ? 50 : 100;
    else out[i] = 100 - 100 / (1 + gain / loss);
  }

  return out;
}

function sessionVwap(candles: Candle[]): number[] {
  if (!candles.length) return [];
  let cumPv = 0;
  let cumVol = 0;

  return candles.map((c) => {
    const typical = (c.high + c.low + c.close) / 3;
    cumPv += typical * c.volume;
    cumVol += c.volume;
    return cumVol === 0 ? c.close : cumPv / cumVol;
  });
}

function atr(candles: Candle[], period = 14): number[] {
  if (!candles.length) return [];
  const trs: number[] = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  return ema(trs, period);
}

function trimSeries<T>(arr: T[], n: number): T[] {
  if (!arr.length) return [];
  const maxPoints = Math.max(1, Math.min(arr.length, n));
  return arr.slice(-maxPoints);
}

function detectSetups(candles: Candle[], ema20: number[], vwap: number[]): SetupHint[] {
  if (candles.length < 20) return [];

  const n = candles.length - 1;
  const last = candles[n];
  const prevWindow = candles.slice(Math.max(0, n - 20), n);
  const prevHigh = prevWindow.length ? Math.max(...prevWindow.map((c) => c.high)) : last.high;
  const prevLow = prevWindow.length ? Math.min(...prevWindow.map((c) => c.low)) : last.low;

  const hints: SetupHint[] = [];

  const emaRising = ema20.length > 5 && ema20[n] > ema20[n - 5];
  const vwapBase = vwap[n] || last.close;
  const nearVwap = Math.abs(last.close - vwapBase) / vwapBase < 0.003;
  const bouncedUp = last.close > last.open;

  if (emaRising && nearVwap && bouncedUp) {
    hints.push({
      name: "pullback_vwap_uptrend",
      active: true,
      confidence: 0.72,
      note: "EMA20 naik dan candle terakhir close dekat VWAP setelah pullback singkat",
    });
  } else {
    hints.push({
      name: "pullback_vwap_uptrend",
      active: false,
      confidence: 0.0,
      note: "Belum ada kondisi pullback VWAP yang cukup kuat",
    });
  }

  const recentBreakoutWindow = candles.slice(Math.max(0, n - 5), n);
  const brokeOut = recentBreakoutWindow.some((c) => c.close > prevHigh);
  const retestHolding = last.low <= prevHigh * 1.002 && last.close > prevHigh;

  if (brokeOut && retestHolding) {
    hints.push({
      name: "breakout_retest",
      active: true,
      confidence: 0.75,
      note: "Harga sempat menembus high sebelumnya dan close bertahan di atasnya",
    });
  } else {
    hints.push({
      name: "breakout_retest",
      active: false,
      confidence: 0.0,
      note: "Belum ada breakout-retest yang valid",
    });
  }

  if (last.low < prevLow && last.close > prevLow) {
    hints.push({
      name: "sweep_reclaim",
      active: true,
      confidence: 0.68,
      note: "Sweep low sebelumnya tapi close reclaim di atas level low lama",
    });
  } else {
    hints.push({
      name: "sweep_reclaim",
      active: false,
      confidence: 0.0,
      note: "Belum ada sweep-reclaim yang terkonfirmasi",
    });
  }

  return hints;
}

function textResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function getAppDir(): string {
  const home = process.env.HOME || "/data/data/com.termux/files/home";
  return `${home}/.omp/agent/extensions/tokocrypto-direct`;
}

function getPaperStatePath(): string {
  return `${getAppDir()}/paper_trade_state.json`;
}

function getDefaultRiskConfig(): RiskConfig {
  return {
    maxPositions: 3,
    maxExposurePercent: 30,
    maxDailyLossPercent: 5,
    feeBps: 10,
    slippageBps: 20,
    maxOrderNotionalUsd: 500,
    enabled: true,
  };
}

function getDefaultPaperState(): PaperState {
  const now = nowIso();
  return {
    version: 1,
    equityUsd: 10000,
    cashUsd: 10000,
    positions: [],
    journal: [],
    pairSummaries: {},
    createdAt: now,
    updatedAt: now,
    config: getDefaultRiskConfig(),
  };
}

async function readPaperState(): Promise<PaperState> {
  const fs = await import("node:fs/promises");
  const path = getPaperStatePath();

  try {
    const raw = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PaperState>;
    const state = getDefaultPaperState();

    return {
      ...state,
      ...parsed,
      config: {
        ...state.config,
        ...(parsed.config ?? {}),
      },
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      journal: Array.isArray(parsed.journal) ? parsed.journal : [],
      pairSummaries: parsed.pairSummaries ?? {},
      equityUsd: Number(parsed.equityUsd ?? state.equityUsd),
      cashUsd: Number(parsed.cashUsd ?? state.cashUsd),
    };
  } catch {
    await fs.mkdir(getAppDir(), { recursive: true });
    const blank = getDefaultPaperState();
    await fs.writeFile(path, JSON.stringify(blank, null, 2), "utf-8");
    return blank;
  }
}

async function writePaperState(state: PaperState): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = getPaperStatePath();
  await fs.mkdir(getAppDir(), { recursive: true });
  await fs.writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

function getOpenPosition(state: PaperState, symbol: string): Position | undefined {
  return state.positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(symbol));
}

function currentMarkPriceForPosition(position: Position, freshPrice?: number): number {
  return typeof freshPrice === "number" && Number.isFinite(freshPrice) ? freshPrice : position.avgPrice;
}

function updatePairSummary(state: PaperState, symbol: string, pnlDeltaUsd: number): void {
  const pair = pairFromSymbol(symbol);
  const summary = state.pairSummaries[pair] ?? {
    pair,
    trades: 0,
    wins: 0,
    losses: 0,
    totalPnlUsd: 0,
    lastUpdatedAt: nowIso(),
  };

  summary.totalPnlUsd += pnlDeltaUsd;
  summary.lastUpdatedAt = nowIso();
  summary.trades += 1;

  if (pnlDeltaUsd > 0) summary.wins += 1;
  if (pnlDeltaUsd < 0) summary.losses += 1;

  state.pairSummaries[pair] = summary;
}

function addTradeJournalEntry(
  state: PaperState,
  entry: Omit<TradeJournalEntry, "tradeId" | "ts"> & { tradeId?: string; ts?: string }
): void {
  const normalizedSymbol = normalizeSymbol(entry.symbol);
  const pair = pairFromSymbol(normalizedSymbol);
  const item: TradeJournalEntry = {
    tradeId: entry.tradeId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: normalizedSymbol,
    pair,
    side: entry.side,
    type: entry.type,
    qty: entry.qty,
    price: entry.price,
    amountUsd: entry.amountUsd,
    ts: entry.ts || nowIso(),
    notes: entry.notes,
    analysis: entry.analysis,
    decision: entry.decision,
  };

  state.journal.unshift(item);
  updatePairSummary(state, normalizedSymbol, entry.amountUsd * (entry.type === "CLOSE" ? 0 : 0));
}

function recalcPositionMetrics(state: PaperState, markPrices: Record<string, number>): void {
  let totalPortfolioValue = state.cashUsd;
  for (const pos of state.positions) {
    const symbol = normalizeSymbol(pos.symbol);
    const markPrice = markPrices[symbol] ?? pos.avgPrice;
    const value = Math.abs(pos.quantity) * markPrice;

    pos.unrealizedPnl =
      pos.side === "BUY"
        ? (markPrice - pos.avgPrice) * pos.quantity
        : (pos.avgPrice - markPrice) * Math.abs(pos.quantity);

    pos.lastUpdatedAt = nowIso();
    totalPortfolioValue += pos.side === "BUY" ? value : value;
  }
  state.equityUsd = totalPortfolioValue;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function paperExecuteOrder(
  symbol: string,
  side: PositionSide,
  notionalUsd: number,
  marketPrice?: number
): Promise<{ ok: boolean; message: string; state?: PaperState }> {
  const state = await readPaperState();
  const config = state.config;

  if (!config.enabled) {
    return { ok: false, message: "Paper trading sedang non-aktif. Gunakan paper_set_risk_config untuk mengaktifkan." };
  }

  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
    return { ok: false, message: "notionalUsd harus > 0" };
  }

  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedMarketPrice = typeof marketPrice === "number" && Number.isFinite(marketPrice)
    ? marketPrice
    : await fetchLatestPrice(normalizedSymbol, "1m", 20);

  const maxOrder = config.maxOrderNotionalUsd;
  if (notionalUsd > maxOrder) {
    return { ok: false, message: `Order melebihi maxOrderNotionalUsd (${maxOrder}).` };
  }

  const feeRate = config.feeBps / 10000;
  const slippageFactor = config.slippageBps / 10000;
  const fee = notionalUsd * feeRate;
  const slippage = notionalUsd * slippageFactor;
  const executionPrice =
    side === "BUY"
      ? normalizedMarketPrice * (1 + slippageFactor)
      : normalizedMarketPrice * (1 - slippageFactor);

  const qty = notionalUsd / normalizedMarketPrice;
  const existing = getOpenPosition(state, normalizedSymbol);

  if (side === "BUY") {
    const totalCost = notionalUsd + fee + slippage;
    if (state.cashUsd < totalCost) {
      return { ok: false, message: "Cash tidak cukup untuk order BUY" };
    }

    if (existing) {
      const prevValue = existing.avgPrice * Math.abs(existing.quantity);
      const newValue = executionPrice * qty;
      const totalQty = Math.abs(existing.quantity) + qty;
      const totalValue = prevValue + newValue;

      existing.side = "BUY";
      existing.avgPrice = totalValue / totalQty;
      existing.quantity = totalQty;
      existing.lastUpdatedAt = nowIso();
    } else {
      state.positions.push({
        symbol: normalizedSymbol,
        side: "BUY",
        quantity: qty,
        avgPrice: executionPrice,
        openedAt: nowIso(),
        lastUpdatedAt: nowIso(),
        realizedPnl: 0,
        unrealizedPnl: 0,
      });
    }

    state.cashUsd -= totalCost;
    addTradeJournalEntry(state, {
      symbol: normalizedSymbol,
      side,
      type: "OPEN",
      qty,
      price: executionPrice,
      amountUsd: notionalUsd,
      notes: `BUY paper order @ ${executionPrice}`,
    });
    addTradeJournalEntry(state, {
      symbol: normalizedSymbol,
      side,
      type: "FEE",
      qty: 0,
      price: 0,
      amountUsd: fee + slippage,
      notes: "paper fee + slippage",
    });
  } else {
    const openCredit = notionalUsd - fee - slippage;
    if (state.positions.length >= config.maxPositions && !existing) {
      return { ok: false, message: `Melebihi maxPositions (${config.maxPositions}).` };
    }

    if (existing && existing.side === "BUY") {
      const remainingQty = Math.abs(existing.quantity) - qty;
      if (remainingQty < 0) {
        const newShortQty = Math.abs(remainingQty);
        const currentValue = existing.avgPrice * Math.abs(existing.quantity);
        state.cashUsd += openCredit;
        existing.side = "SELL";
        existing.quantity = -newShortQty;
        existing.avgPrice = executionPrice;
        existing.lastUpdatedAt = nowIso();
        existing.realizedPnl += currentValue * 0;

        addTradeJournalEntry(state, {
          symbol: normalizedSymbol,
          side,
          type: "ADJUST",
          qty: qty,
          price: executionPrice,
          amountUsd: notionalUsd,
          notes: "flip long menjadi short",
        });
      } else {
        existing.quantity = remainingQty;
        existing.lastUpdatedAt = nowIso();
        addTradeJournalEntry(state, {
          symbol: normalizedSymbol,
          side,
          type: "CLOSE",
          qty,
          price: executionPrice,
          amountUsd: notionalUsd,
          notes: "close long secara partial",
        });
      }
    } else {
      const shortQty = qty;
      const pos = existing ?? {
        symbol: normalizedSymbol,
        side: "SELL",
        quantity: 0,
        avgPrice: executionPrice,
        openedAt: nowIso(),
        lastUpdatedAt: nowIso(),
        realizedPnl: 0,
        unrealizedPnl: 0,
      };

      if (!existing) {
        pos.quantity = -shortQty;
        pos.avgPrice = executionPrice;
        state.positions.push(pos);
      } else {
        const totalQty = Math.abs(existing.quantity) + shortQty;
        const prevValue = existing.avgPrice * Math.abs(existing.quantity);
        const newValue = executionPrice * shortQty;
        existing.avgPrice = (prevValue + newValue) / totalQty;
        existing.quantity = -totalQty;
        existing.side = "SELL";
      }

      state.cashUsd += openCredit;
      addTradeJournalEntry(state, {
        symbol: normalizedSymbol,
        side,
        type: "OPEN",
        qty: shortQty,
        price: executionPrice,
        amountUsd: notionalUsd,
        notes: `SELL short paper order @ ${executionPrice}`,
      });
      addTradeJournalEntry(state, {
        symbol: normalizedSymbol,
        side,
        type: "FEE",
        qty: 0,
        price: 0,
        amountUsd: fee + slippage,
        notes: "paper fee + slippage",
      });
    }
  }

  const markPrices: Record<string, number> = {};
  for (const pos of state.positions) {
    const key = normalizeSymbol(pos.symbol);
    const fresh = await fetchLatestPrice(key, "1m", 10).catch(() => pos.avgPrice);
    markPrices[key] = fresh;
  }

  recalcPositionMetrics(state, markPrices);
  state.updatedAt = nowIso();
  await writePaperState(state);

  return {
    ok: true,
    message: `Paper order ${side} berhasil untuk ${normalizedSymbol}`,
    state,
  };
}

async function paperClosePosition(symbol: string): Promise<{ ok: boolean; message: string; state?: PaperState }> {
  const state = await readPaperState();
  const normalizedSymbol = normalizeSymbol(symbol);
  const pos = getOpenPosition(state, normalizedSymbol);

  if (!pos) {
    return { ok: false, message: `Tidak ada posisi terbuka untuk ${normalizedSymbol}` };
  }

  const freshPrice = await fetchLatestPrice(normalizedSymbol, "1m", 10).catch(() => pos.avgPrice);
  const closeQty = Math.abs(pos.quantity);
  const proceeds = closeQty * freshPrice;
  const fee = proceeds * (state.config.feeBps / 10000);

  const realizedPnl =
    pos.side === "BUY"
      ? (freshPrice - pos.avgPrice) * pos.quantity
      : (pos.avgPrice - freshPrice) * Math.abs(pos.quantity);

  state.cashUsd += proceeds - fee;
  pos.realizedPnl += realizedPnl;

  addTradeJournalEntry(state, {
    symbol: normalizedSymbol,
    side: pos.side,
    type: "CLOSE",
    qty: closeQty,
    price: freshPrice,
    amountUsd: proceeds,
    notes: `close posisi ${pos.side} @ ${freshPrice}`,
  });

  addTradeJournalEntry(state, {
    symbol: normalizedSymbol,
    side: pos.side,
    type: "PNL",
    qty: 0,
    price: freshPrice,
    amountUsd: realizedPnl,
    notes: `realized P&L ${realizedPnl}`,
  });

  addTradeJournalEntry(state, {
    symbol: normalizedSymbol,
    side: pos.side,
    type: "FEE",
    qty: 0,
    price: 0,
    amountUsd: fee,
    notes: "paper close fee",
  });

  state.positions = state.positions.filter((p) => normalizeSymbol(p.symbol) !== normalizedSymbol);
  state.updatedAt = nowIso();
  state.equityUsd = state.cashUsd;

  await writePaperState(state);
  return { ok: true, message: `Posisi ${normalizedSymbol} ditutup`, state };
}

async function paperGetBalance(): Promise<PaperState> {
  const state = await readPaperState();
  const markPrices: Record<string, number> = {};
  for (const pos of state.positions) {
    const key = normalizeSymbol(pos.symbol);
    markPrices[key] = await fetchLatestPrice(key, "1m", 10).catch(() => pos.avgPrice);
  }
  recalcPositionMetrics(state, markPrices);
  await writePaperState(state);
  return state;
}

async function paperGetPairSummary(symbol: string): Promise<TradeJournalEntry[]> {
  const state = await readPaperState();
  const pair = pairFromSymbol(symbol);
  return state.journal.filter((entry) => entry.pair === pair);
}

async function paperPairSummary(symbol: string): Promise<PaperState> {
  const state = await readPaperState();
  const pair = pairFromSymbol(symbol);
  const entries = state.journal.filter((e) => e.pair === pair);
  const pnlTotal = entries
    .filter((e) => e.type === "PNL")
    .reduce((sum, e) => sum + Number(e.amountUsd || 0), 0);

  state.pairSummaries[pair] = {
    pair,
    trades: entries.length,
    wins: entries.filter((e) => e.type === "PNL" && Number(e.amountUsd || 0) > 0).length,
    losses: entries.filter((e) => e.type === "PNL" && Number(e.amountUsd || 0) < 0).length,
    totalPnlUsd: pnlTotal,
    lastUpdatedAt: nowIso(),
  };
  await writePaperState(state);
  return state;
}

function getLiveTradeEnv(): { enabled: boolean; reason: string } {
  const key = process.env.TOKOCRYPTO_API_KEY;
  const secret = process.env.TOKOCRYPTO_API_SECRET;
  if (!key || !secret) {
    return {
      enabled: false,
      reason: "Live trade belum aktif: TOKOCRYPTO_API_KEY dan TOKOCRYPTO_API_SECRET belum diset.",
    };
  }

  return {
    enabled: true,
    reason: "Live trade enabled dari env",
  };
}

export default function tokocryptoDirect(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("tokocrypto-direct loaded — paper trading + journal ready, live execution disabled by default", "info");
  });

  pi.registerTool({
    name: "get_klines_tokocrypto",
    label: "Get klines (direct)",
    description:
      "Ambil candle OHLCV langsung dari API publik Tokocrypto (tanpa app analisa-pasar, tanpa API key)",
    parameters: z.object({
      symbol: z.string().describe("mis. BTC_USDT"),
      interval: z.string().default("1m").describe("mis. 1m, 5m, 15m, 1h"),
      limit: z.number().min(20).max(500).default(200),
      start_time_ms: z.number().optional().describe("Epoch ms, mundur ke masa lalu"),
      end_time_ms: z.number().optional().describe("Epoch ms, batas akhir"),
    }),
    async execute(_toolCallId, params) {
      const candles = await fetchKlines(
        params.symbol,
        params.interval,
        params.limit,
        params.start_time_ms,
        params.end_time_ms
      );

      return textResult({
        symbol: normalizeSymbol(params.symbol),
        interval: params.interval,
        count: candles.length,
        source: "tokocrypto-public-api",
        range: {
          start: params.start_time_ms ? new Date(params.start_time_ms).toISOString() : "default (terbaru)",
          end: params.end_time_ms ? new Date(params.end_time_ms).toISOString() : "sekarang",
        },
        candles,
      });
    },
  });

  pi.registerTool({
    name: "analyze_market_tokocrypto",
    label: "Analyze market (raw + hints)",
    description:
      "Fetch candle Tokocrypto + hitung indikator, lalu kirim seri mentah supaya agent bisa reasoning sendiri. 'heuristic_hints' hanya bantu awal, bukan keputusan final.",
    parameters: z.object({
      symbol: z.string().describe("mis. BTC_USDT"),
      interval: z.string().default("5m"),
      limit: z.number().min(50).max(500).default(200),
      series_points: z.number().min(10).max(200).default(50),
    }),
    async execute(_toolCallId, params) {
      const candles = await fetchKlines(params.symbol, params.interval, params.limit);
      const close = candles.map((c) => c.close);
      const ema20 = ema(close, 20);
      const rsi14 = rsi(close, 14);
      const vwap = sessionVwap(candles);
      const atr14 = atr(candles, 14);
      const hints = detectSetups(candles, ema20, vwap);

      return textResult({
        symbol: normalizeSymbol(params.symbol),
        interval: params.interval,
        disclaimer:
          "Data mentah untuk reasoning kamu sendiri. heuristic_hints cuma bantuan awal dari threshold tetap di kode, bisa salah/kelewat ketat/kelewat longgar — jangan jadi satu-satunya dasar keputusan.",
        raw_candles: trimSeries(candles, params.series_points),
        indicator_series: {
          ema20: trimSeries(ema20, params.series_points),
          rsi14: trimSeries(rsi14, params.series_points),
          vwap: trimSeries(vwap, params.series_points),
          atr14: trimSeries(atr14, params.series_points),
        },
        heuristic_hints: hints,
        metadata: {
          source: "tokocrypto-public-api",
          count: candles.length,
          last_close: close.at(-1),
          last_ema20: ema20.at(-1),
          last_rsi14: rsi14.at(-1),
          last_vwap: vwap.at(-1),
          last_atr14: atr14.at(-1),
        },
      });
    },
  });

  pi.registerTool({
    name: "get_market_history_tokocrypto",
    label: "Get market history (deeper lookback)",
    description:
      "Ambil candle di luar jendela 'live' biasa — bisa mundur ke periode tertentu via startTime/endTime atau multi-timeframe.",
    parameters: z.object({
      symbol: z.string(),
      intervals: z
        .array(z.string())
        .default(["15m", "1h", "4h", "1d"])
        .describe("Daftar timeframe yang mau diambil sekaligus"),
      limit_per_interval: z.number().min(20).max(500).default(100),
      start_time_ms: z.number().optional().describe("Epoch ms, mundur ke masa lalu"),
      end_time_ms: z.number().optional(),
    }),
    async execute(_toolCallId, params) {
      const results: Record<string, unknown> = {};
      for (const itv of params.intervals) {
        try {
          const candles = await fetchKlines(
            params.symbol,
            itv,
            params.limit_per_interval,
            params.start_time_ms,
            params.end_time_ms
          );
          results[itv] = candles;
        } catch (e) {
          results[itv] = { error: String(e) };
        }
      }

      return textResult({
        symbol: normalizeSymbol(params.symbol),
        range: {
          start: params.start_time_ms ? new Date(params.start_time_ms).toISOString() : "default (terbaru)",
          end: params.end_time_ms ? new Date(params.end_time_ms).toISOString() : "sekarang",
        },
        by_interval: results,
        note: "Gunakan ini untuk bandingkan konteks besar vs sinyal kecil sebelum menyimpulkan.",
      });
    },
  });

  // ---------- Paper Trading Tools ----------
  pi.registerTool({
    name: "paper_set_risk_config",
    label: "Paper risk config",
    description: "Atur batas risiko paper trading seperti maxPositions, fee, slippage, dan max order size",
    parameters: z.object({
      max_positions: z.number().int().min(1).max(20).optional(),
      max_exposure_percent: z.number().min(1).max(100).optional(),
      max_daily_loss_percent: z.number().min(0.1).max(50).optional(),
      fee_bps: z.number().min(0).max(200).optional(),
      slippage_bps: z.number().min(0).max(200).optional(),
      max_order_notional_usd: z.number().min(10).max(100000).optional(),
      enabled: z.boolean().optional(),
    }),
    async execute(_toolCallId, params) {
      const state = await readPaperState();
      const cfg = state.config;
      if (params.max_positions !== undefined) cfg.maxPositions = params.max_positions;
      if (params.max_exposure_percent !== undefined) cfg.maxExposurePercent = params.max_exposure_percent;
      if (params.max_daily_loss_percent !== undefined) cfg.maxDailyLossPercent = params.max_daily_loss_percent;
      if (params.fee_bps !== undefined) cfg.feeBps = params.fee_bps;
      if (params.slippage_bps !== undefined) cfg.slippageBps = params.slippage_bps;
      if (params.max_order_notional_usd !== undefined) cfg.maxOrderNotionalUsd = params.max_order_notional_usd;
      if (params.enabled !== undefined) cfg.enabled = params.enabled;

      state.config = cfg;
      state.updatedAt = nowIso();
      await writePaperState(state);

      return textResult({
        ok: true,
        message: "Paper risk config berhasil diperbarui",
        config: cfg,
      });
    },
  });

  pi.registerTool({
    name: "paper_get_balance",
    label: "Paper account balance",
    description: "Lihat saldo, portofolio, dan posisi paper trading saat ini",
    parameters: z.object({}),
    async execute() {
      const state = await paperGetBalance();
      return textResult({ ok: true, state });
    },
  });

  pi.registerTool({
    name: "paper_open_position",
    label: "Paper open position",
    description: "Buka posisi paper trading baru atau tambahkan ke posisi yang ada",
    parameters: z.object({
      symbol: z.string().describe("mis. BTC_USDT"),
      side: z.enum(["BUY", "SELL"]).describe("BUY = long, SELL = short"),
      notional_usd: z.number().min(1).max(100000).describe("Nominal USD yang dipakai untuk order paper"),
      market_price: z.number().min(0.0000001).optional().describe("Optional, jika kosong akan diambil harga terbaru dari API"),
    }),
    async execute(_toolCallId, params) {
      const result = await paperExecuteOrder(
        params.symbol,
        params.side,
        params.notional_usd,
        params.market_price
      );
      return textResult({ ok: result.ok, message: result.message, state: result.state ?? null });
    },
  });

  pi.registerTool({
    name: "paper_close_position",
    label: "Paper close position",
    description: "Tutup posisi paper trading untuk symbol tertentu, dengan market price fresh",
    parameters: z.object({
      symbol: z.string().describe("mis. BTC_USDT"),
    }),
    async execute(_toolCallId, params) {
      const result = await paperClosePosition(params.symbol);
      return textResult({ ok: result.ok, message: result.message, state: result.state ?? null });
    },
  });

  pi.registerTool({
    name: "paper_positions",
    label: "Paper positions",
    description: "Tampilkan semua posisi terbuka dan summary mark-to-market saat ini",
    parameters: z.object({}),
    async execute() {
      const state = await paperGetBalance();
      return textResult({
        ok: true,
        positions: state.positions,
        cashUsd: state.cashUsd,
        equityUsd: state.equityUsd,
      });
    },
  });

  pi.registerTool({
    name: "paper_trade_history",
    label: "Paper trade history",
    description: "Tampilkan jurnal eksekusi paper trade dan log per pair",
    parameters: z.object({}),
    async execute() {
      const state = await readPaperState();
      return textResult({
        ok: true,
        count: state.journal.length,
        journal: state.journal,
      });
    },
  });

  pi.registerTool({
    name: "paper_pair_journal",
    label: "Paper pair journal",
    description: "Tampilkan jurnal per pair (mis. BTC_USDT) untuk evaluasi secara terpisah",
    parameters: z.object({
      symbol: z.string().describe("mis. BTC_USDT"),
    }),
    async execute(_toolCallId, params) {
      const entries = await paperGetPairSummary(params.symbol);
      return textResult({
        ok: true,
        symbol: normalizeSymbol(params.symbol),
        pair: pairFromSymbol(params.symbol),
        count: entries.length,
        entries,
      });
    },
  });

  pi.registerTool({
    name: "paper_pair_summary",
    label: "Paper pair summary",
    description: "Ringkas P&L dan tren per pair untuk evaluasi journal",
    parameters: z.object({
      symbol: z.string().describe("mis. BTC_USDT"),
    }),
    async execute(_toolCallId, params) {
      const state = await paperPairSummary(params.symbol);
      const pair = pairFromSymbol(params.symbol);
      return textResult({
        ok: true,
        pair,
        summary: state.pairSummaries[pair] ?? {
          pair,
          trades: 0,
          wins: 0,
          losses: 0,
          totalPnlUsd: 0,
          lastUpdatedAt: nowIso(),
        },
      });
    },
  });

  pi.registerTool({
    name: "write_trade_journal_direct",
    label: "Write journal entry (direct)",
    description: "Tulis jurnal analisa atau decision log per pair untuk monitoring 24/7 dan evaluasi masa depan",
    parameters: z.object({
      symbol: z.string(),
      decision: z.enum(["BUY", "SELL", "HOLD", "WAIT"]),
      analysis: z.string(),
      notes: z.string().optional(),
    }),
    async execute(_toolCallId, params) {
      const state = await readPaperState();
      const symbol = normalizeSymbol(params.symbol);
      const pair = pairFromSymbol(symbol);
      const entry: TradeJournalEntry = {
        tradeId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        pair,
        side: params.decision === "BUY" ? "BUY" : params.decision === "SELL" ? "SELL" : "BUY",
        type: "DECISION",
        qty: 0,
        price: 0,
        amountUsd: 0,
        ts: nowIso(),
        notes: params.notes,
        analysis: params.analysis,
        decision: params.decision,
      };

      state.journal.unshift(entry);
      state.updatedAt = nowIso();
      await writePaperState(state);

      return textResult({
        ok: true,
        message: "Jurnal keputusan sukses ditulis",
        entry,
      });
    },
  });

  // ---------- Research Log Tools ----------
  pi.registerTool({
    name: "read_research_log_direct",
    label: "Read past research logs",
    description:
      "Baca ulang log riset Markdown yang pernah ditulis agent sendiri (folder tokocrypto-direct/research)",
    parameters: z.object({
      symbol: z.string().optional().describe("Filter symbol, mis. BTC_USDT. Kosongkan untuk semua."),
      limit: z.number().min(1).max(50).default(10),
    }),
    async execute(_toolCallId, params) {
      try {
        const fs = await import("node:fs/promises");
        const home = process.env.HOME || "/data/data/com.termux/files/home";
        const dir = `${home}/storage/shared/tokocrypto-direct/research`;
        const files = await fs.readdir(dir).catch(() => [] as string[]);
        const filtered = files
          .filter((f) => f.endsWith(".md"))
          .filter((f) => (params.symbol ? f.toUpperCase().startsWith(normalizeSymbol(params.symbol)) : true))
          .sort()
          .reverse()
          .slice(0, params.limit);

        const entries = await Promise.all(
          filtered.map(async (f) => ({
            file: f,
            content: await fs.readFile(`${dir}/${f}`, "utf-8"),
          }))
        );

        return textResult({
          dir,
          count: entries.length,
          entries,
          note: entries.length === 0 ? "Belum ada log riset tersimpan di folder ini" : undefined,
        });
      } catch (e) {
        return textResult({ error: `Gagal baca log riset: ${e}` });
      }
    },
  });

  pi.registerTool({
    name: "write_research_log_direct",
    label: "Write research log (direct)",
    description: "Tulis log riset Markdown hasil analisa mandiri",
    parameters: z.object({
      symbol: z.string(),
      analysis: z.string(),
      decision: z.enum(["BUY", "SELL", "HOLD", "WAIT"]),
    }),
    async execute(_toolCallId, params) {
      const fs = await import("node:fs/promises");
      const home = process.env.HOME || "/data/data/com.termux/files/home";
      const dir = `${home}/storage/shared/tokocrypto-direct/research`;
      await fs.mkdir(dir, { recursive: true });
      const path = `${dir}/${normalizeSymbol(params.symbol)}_${Date.now()}.md`;
      await fs.writeFile(
        path,
        `# ${normalizeSymbol(params.symbol)} — ${nowIso()}\n\nDecision: **${params.decision}**\n\n${params.analysis}\n`
      );
      return textResult({ saved: path });
    },
  });

  // ---------- Live Trade Guard ----------
  pi.registerTool({
    name: "real_trade_status_tokocrypto",
    label: "Check live trading readiness",
    description:
      "Cek apakah live execution sudah siap diaktifkan. Default selalu OFF sampai env dan konfirmasi manual diset.",
    parameters: z.object({}),
    async execute() {
      const status = getLiveTradeEnv();
      return textResult({
        enabled: status.enabled,
        reason: status.reason,
        note: "Live trade aman secara default: OFF sampai operator menyediakan token + secret dan mengaktifkan dengan konfirmasi eksplisit.",
      });
    },
  });

  // ---------- Slash command ----------
  pi.registerCommand("analisa", {
    description: "Analisa market Tokocrypto langsung, deterministik. Pakai: /analisa SYMBOL [interval] [limit]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;

      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const symbol = normalizeSymbol(parts[0] || "BTC_USDT");
      const interval = parts[1] || "5m";
      const limit = Number(parts[2]) || 200;

      try {
        const candles = await fetchKlines(symbol, interval, limit);
        const close = candles.map((c) => c.close);
        const ema20 = ema(close, 20);
        const rsi14 = rsi(close, 14);
        const vwap = sessionVwap(candles);
        const atr14 = atr(candles, 14);
        const setups = detectSetups(candles, ema20, vwap);
        const last = candles[candles.length - 1];

        const lines = [
          `${symbol} (${interval}) @ ${last.close}`,
          `EMA20=${ema20.at(-1)?.toFixed(4)}  RSI14=${rsi14.at(-1)?.toFixed(2)}  VWAP=${vwap.at(-1)?.toFixed(4)}  ATR14=${atr14.at(-1)?.toFixed(4)}`,
          setups.some((s) => s.active)
            ? `Setup: ${setups.filter((s) => s.active).map((s) => s.name).join(", ")}`
            : "Setup: belum ada yang match",
        ];

        ctx.ui.notify(lines.join("\n"), "info");
      } catch (e) {
        ctx.ui.notify(`Gagal analisa ${symbol}: ${e}`, "warning");
      }
    },
  });
}
