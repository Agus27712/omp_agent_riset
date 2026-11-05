/**
 * tokocrypto-direct — extension mandiri untuk omp 18.x
 *
 * Path (OMP 18, Termux):
 *   ~/.omp/agent/extensions/tokocrypto-direct/index.ts
 *
 * BEDA dari extension "analisa-pasar":
 *   - TIDAK bergantung ke app Android analisa-pasar
 *   - TIDAK ada bridge HTTP/WS ke 127.0.0.1:8765
 *   - Agent fetch candle langsung dari API publik Tokocrypto,
 *     dan hitung indikator (EMA/RSI/VWAP/ATR) sendiri di dalam extension ini
 *   - Market data publik Tokocrypto TIDAK butuh API key/secret
 *
 * PRINSIP: kode ini cuma penyedia DATA MENTAH + hint kasar (threshold tetap),
 * BUKAN pengambil keputusan. Semua tool sengaja mengirim raw candles + raw
 * indicator series (bukan cuma satu angka kesimpulan) dan membuka akses ke
 * histori yang lebih jauh (multi-timeframe, startTime/endTime, log riset lama)
 * supaya reasoning akhir ada di agent (LLM), bukan terpatok ke detectSetups()
 * di file ini.
 *
 * Format: export default function (pi) — wajib di omp 18.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Dua base URL yang didukung Tokocrypto untuk data publik; open/v1 dicoba dulu,
// fallback ke /api/v3 (gaya Binance-compatible) kalau gagal.
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

function normalizeKline(raw: unknown[]): Candle {
  return {
    openTime: Number(raw[0]),
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
    volume: Number(raw[5]),
  };
}

async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
  startTime?: number,
  endTime?: number
): Promise<Candle[]> {
  const range = `${startTime ? `&startTime=${startTime}` : ""}${endTime ? `&endTime=${endTime}` : ""}`;
  const attempts = [
    `${BASE_OPEN}/market/klines?symbol=${symbol}&interval=${interval}&limit=${limit}${range}`,
    `${BASE_BINANCE_STYLE}/klines?symbol=${symbol.replace("_", "")}&interval=${interval}&limit=${limit}${range}`,
  ];
  let lastErr: unknown;
  for (const url of attempts) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as unknown[];
      const list = Array.isArray(data) ? data : (data as any)?.data;
      if (!Array.isArray(list) || list.length === 0) throw new Error("payload kosong");
      return list.map((row) => normalizeKline(row as unknown[]));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Gagal fetch klines Tokocrypto untuk ${symbol}: ${lastErr}`);
}

// ---------- Indikator (hitung sendiri, tanpa dependency npm) ----------

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
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
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function sessionVwap(candles: Candle[]): number[] {
  let cumPV = 0, cumVol = 0;
  return candles.map((c) => {
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumVol += c.volume;
    return cumVol === 0 ? c.close : cumPV / cumVol;
  });
}

function atr(candles: Candle[], period = 14): number[] {
  const trs: number[] = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  return ema(trs, period);
}

function trimSeries<T>(arr: T[], n: number): T[] {
  return arr.slice(Math.max(0, arr.length - n));
}

// ---------- Hint ringan, BUKAN keputusan final ----------
// Ini cuma pola kasar (pullback VWAP, breakout-retest, sweep-reclaim) berdasar
// threshold tetap. Agent (LLM) tetap harus lihat raw candles + raw indicator
// series + histori sebelum menyimpulkan — jangan anggap field ini sebagai sinyal jadi.
function detectSetups(candles: Candle[], close: number[], ema20: number[], vwap: number[]) {
  const n = candles.length - 1;
  const last = candles[n];
  const flags: string[] = [];

  // Pullback VWAP di tren naik: EMA20 naik & harga close dekat/di atas VWAP setelah sentuh di bawahnya
  const emaRising = ema20[n] > ema20[n - 5];
  const nearVwap = Math.abs(last.close - vwap[n]) / vwap[n] < 0.003;
  const bouncedUp = last.close > last.open;
  if (emaRising && nearVwap && bouncedUp) flags.push("pullback_vwap_uptrend");

  // Breakout-retest: tembus high 20 candle sebelumnya, lalu retest tanpa close di bawahnya
  const prevHigh = Math.max(...candles.slice(Math.max(0, n - 20), n).map((c) => c.high));
  const brokeOut = candles.slice(Math.max(0, n - 5), n).some((c) => c.close > prevHigh);
  const retestHolding = last.low <= prevHigh * 1.002 && last.close > prevHigh;
  if (brokeOut && retestHolding) flags.push("breakout_retest");

  // Sweep-reclaim: wick tembus low N candle sebelumnya tapi close reclaim di atasnya
  const prevLow = Math.min(...candles.slice(Math.max(0, n - 20), n).map((c) => c.low));
  if (last.low < prevLow && last.close > prevLow) flags.push("sweep_reclaim");

  return flags;
}

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export default function tokocryptoDirect(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("tokocrypto-direct loaded (self-compute, no app dependency)", "info");
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
    }),
    async execute(_toolCallId, params) {
      const candles = await fetchKlines(params.symbol, params.interval, params.limit);
      return textResult({ symbol: params.symbol, interval: params.interval, count: candles.length, candles });
    },
  });

  pi.registerTool({
    name: "analyze_market_tokocrypto",
    label: "Analyze market (raw + hints)",
    description:
      "Fetch candle Tokocrypto + hitung indikator, TAPI kirim SERI MENTAH (bukan cuma nilai terakhir) supaya agent bisa reasoning sendiri atas tren/histori-nya. 'heuristic_hints' cuma pola kasar berdasar threshold tetap — JANGAN dianggap sinyal final, selalu cross-check ke raw_candles + series sebelum menyimpulkan BUY/SELL/HOLD.",
    parameters: z.object({
      symbol: z.string().describe("mis. BTC_USDT"),
      interval: z.string().default("5m"),
      limit: z.number().min(50).max(500).default(200),
      series_points: z
        .number()
        .min(10)
        .max(200)
        .default(50)
        .describe("Berapa titik terakhir dari tiap indikator yang dikirim mentah (untuk lihat tren, bukan cuma snapshot)"),
    }),
    async execute(_toolCallId, params) {
      const candles = await fetchKlines(params.symbol, params.interval, params.limit);
      const close = candles.map((c) => c.close);
      const ema20 = ema(close, 20);
      const rsi14 = rsi(close, 14);
      const vwap = sessionVwap(candles);
      const atr14 = atr(candles, 14);
      const hints = detectSetups(candles, close, ema20, vwap);
      const n = params.series_points;

      return textResult({
        symbol: params.symbol,
        interval: params.interval,
        disclaimer:
          "Data mentah untuk reasoning kamu sendiri. heuristic_hints cuma bantuan awal dari threshold tetap di kode, bisa salah/kelewat ketat/kelewat longgar — jangan jadi satu-satunya dasar keputusan.",
        raw_candles: trimSeries(candles, n), // open/high/low/close/volume per candle
        indicator_series: {
          ema20: trimSeries(ema20, n),
          rsi14: trimSeries(rsi14, n),
          vwap: trimSeries(vwap, n),
          atr14: trimSeries(atr14, n),
        },
        heuristic_hints: hints,
      });
    },
  });

  pi.registerTool({
    name: "get_market_history_tokocrypto",
    label: "Get market history (deeper lookback)",
    description:
      "Ambil candle di luar jendela 'live' biasa — bisa mundur ke periode tertentu via startTime/endTime (epoch ms), atau beberapa timeframe sekaligus untuk konteks besar (misal 1h & 1d) selain timeframe scalping (1m/5m). Pakai ini kalau agent perlu lihat konteks lebih jauh ke belakang sebelum menilai setup saat ini.",
    parameters: z.object({
      symbol: z.string(),
      intervals: z
        .array(z.string())
        .default(["15m", "1h", "4h", "1d"])
        .describe("Daftar timeframe yang mau diambil sekaligus, untuk konteks multi-timeframe"),
      limit_per_interval: z.number().min(20).max(500).default(100),
      start_time_ms: z.number().optional().describe("Epoch ms, mundur ke periode tertentu di masa lalu"),
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
        symbol: params.symbol,
        range: {
          start: params.start_time_ms ? new Date(params.start_time_ms).toISOString() : "default (terbaru)",
          end: params.end_time_ms ? new Date(params.end_time_ms).toISOString() : "sekarang",
        },
        by_interval: results,
        note: "Gunakan ini untuk bandingkan konteks besar (tren 1h/4h/1d) vs sinyal kecil (1m/5m) sebelum menyimpulkan — jangan nilai cuma dari satu timeframe.",
      });
    },
  });

  pi.registerTool({
    name: "read_research_log_direct",
    label: "Read past research logs",
    description:
      "Baca ulang log riset Markdown yang pernah ditulis agent sendiri (folder tokocrypto-direct/research) — supaya agent bisa lihat analisa & keputusan masa lalunya sebelum menilai market sekarang, dan tidak mengulang kesalahan yang sama.",
    parameters: z.object({
      symbol: z.string().optional().describe("Filter nama file berdasar symbol, mis. BTC_USDT. Kosongkan untuk semua."),
      limit: z.number().min(1).max(50).default(10).describe("Jumlah log terbaru yang mau dibaca"),
    }),
    async execute(_toolCallId, params) {
      try {
        const fs = await import("node:fs/promises");
        const home = process.env.HOME || "/data/data/com.termux/files/home";
        const dir = `${home}/storage/shared/tokocrypto-direct/research`;
        const files = await fs.readdir(dir).catch(() => [] as string[]);
        const filtered = files
          .filter((f) => f.endsWith(".md"))
          .filter((f) => (params.symbol ? f.startsWith(params.symbol) : true))
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
    name: "self_check_tokocrypto",
    label: "Self check (ping Tokocrypto)",
    description: "Cek konektivitas langsung ke API publik Tokocrypto (tanpa app, tanpa bridge)",
    parameters: z.object({}),
    async execute() {
      try {
        const res = await fetch(`${BASE_BINANCE_STYLE}/time`, { signal: AbortSignal.timeout(3000) });
        const body = await res.text();
        return textResult({ ok: res.ok, status: res.status, body });
      } catch (e) {
        return textResult({ ok: false, error: String(e) });
      }
    },
  });

  pi.registerTool({
    name: "write_research_log_direct",
    label: "Write research log (direct)",
    description: "Tulis log riset Markdown hasil analisa mandiri (folder TERPISAH dari app analisa-pasar)",
    parameters: z.object({
      symbol: z.string(),
      analysis: z.string(),
      decision: z.enum(["BUY", "SELL", "HOLD", "WAIT"]),
    }),
    async execute(_toolCallId, params) {
      const { symbol, analysis, decision } = params;
      try {
        const fs = await import("node:fs/promises");
        const home = process.env.HOME || "/data/data/com.termux/files/home";
        // sengaja folder beda dari app analisa-pasar agar tidak campur
        const dir = `${home}/storage/shared/tokocrypto-direct/research`;
        await fs.mkdir(dir, { recursive: true });
        const path = `${dir}/${symbol}_${Date.now()}.md`;
        await fs.writeFile(
          path,
          `# ${symbol} — ${new Date().toISOString()}\n\nDecision: **${decision}**\n\n${analysis}\n`
        );
        return textResult({ saved: path });
      } catch (e) {
        return textResult({ error: `Gagal tulis log (izin storage Termux?). ${e}` });
      }
    },
  });

  // ---------- Slash command: trigger deterministik, TANPA lewat LLM ----------
  // Pakai ini kalau mau hemat token: tidak ada reasoning/tool-call, langsung
  // fetch + hitung + tampilkan lewat ctx.ui.notify.
  pi.registerCommand("analisa", {
    description: "Analisa market Tokocrypto langsung, deterministik. Pakai: /analisa SYMBOL [interval] [limit]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const symbol = (parts[0] || "BTC_USDT").toUpperCase();
      const interval = parts[1] || "5m";
      const limit = Number(parts[2]) || 200;

      try {
        const candles = await fetchKlines(symbol, interval, limit);
        const close = candles.map((c) => c.close);
        const ema20 = ema(close, 20);
        const rsi14 = rsi(close, 14);
        const vwap = sessionVwap(candles);
        const atr14 = atr(candles, 14);
        const setups = detectSetups(candles, close, ema20, vwap);
        const last = candles[candles.length - 1];

        const lines = [
          `${symbol} (${interval}) @ ${last.close}`,
          `EMA20=${ema20.at(-1)?.toFixed(4)}  RSI14=${rsi14.at(-1)?.toFixed(2)}  VWAP=${vwap.at(-1)?.toFixed(4)}  ATR14=${atr14.at(-1)?.toFixed(4)}`,
          setups.length ? `Setup: ${setups.join(", ")}` : "Setup: belum ada yang match",
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (e) {
        ctx.ui.notify(`Gagal analisa ${symbol}: ${e}`, "warning");
      }
    },
  });
}
