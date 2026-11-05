# tokocrypto-direct

Extension mandiri untuk OMP 18.x yang mengambil data pasar langsung dari API publik Tokocrypto, menghitung indikator secara lokal, dan menyediakan raw candle + raw indicator series agar agent/LLM bisa melakukan reasoning sendiri tanpa bergantung ke aplikasi Android lain.

Tujuan utama extension ini adalah:
- fetch candle OHLCV dari Tokocrypto secara langsung
- menghitung indikator EMA, RSI, VWAP, ATR tanpa dependency tambahan
- mengembalikan data mentah dan seri indikator agar reasoning ada di agent, bukan di extension
- menyediakan log riset untuk referensi historis
- menjaga agar tidak ada bridge ke app analisa-pasar atau service lokal 127.0.0.1:8765

## Fitur utama

- Data pasar public Tokocrypto langsung
- Support dua endpoint publik:
  - `https://www.tokocrypto.com/open/v1`
  - `https://www.tokocrypto.com/api/v3`
- fetch klines dengan symbol, interval, limit, startTime, endTime
- indikator lokal:
  - EMA
  - RSI
  - VWAP
  - ATR
- heuristic hints ringan (bukan keputusan final):
  - `pullback_vwap_uptrend`
  - `breakout_retest`
  - `sweep_reclaim`
- read/write log riset markdown
- self-check konektivitas ke Tokocrypto
- slash command `/analisa` untuk trigger deterministik

## Struktur repo

```text
.
├── index.ts
├── README.md
└── (folder riset di storage Termux / eksternal jika digunakan)
```

## Lokasi install OMP 18.x

Pada perangkat Termux / Android, extension biasanya dipasang di:

```text
~/.omp/agent/extensions/tokocrypto-direct/index.ts
```

## Kebutuhan

- OMP 18.x
- runtime JavaScript/TypeScript yang mendukung `fetch`
- akses internet ke API Tokocrypto public
- di Termux, izin akses folder storage jika ingin menulis log riset

## Fungsi penting di file

### 1. `fetchKlines()`
Mengambil data candle dari Tokocrypto.

- Symbol contoh: `BTC_USDT`
- Interval contoh: `1m`, `5m`, `15m`, `1h`
- Limit maksimal pada code ini: `500`

Contoh pemanggilan internal:

```ts
const candles = await fetchKlines("BTC_USDT", "5m", 200);
```

### 2. `ema()`
Menghitung EMA.

### 3. `rsi()`
Menghitung RSI.

### 4. `sessionVwap()`
Menghitung VWAP rolling.

### 5. `atr()`
Menghitung ATR.

### 6. `detectSetups()`
Menyediakan hint kasar berdasarkan threshold tetap. Ini BUKAN sinyal final dan harus selalu diverifikasi dengan data mentah.

## Tool yang tersedia

Extension ini mendaftarkan beberapa tool ke OMP agent, di antaranya:

### `get_klines_tokocrypto`
Ambil candle OHLCV langsung dari API publik.

Parameter:
- `symbol` (contoh: `BTC_USDT`)
- `interval` (contoh: `1m`, `5m`, `15m`, `1h`)
- `limit` (20–500)

### `analyze_market_tokocrypto`
Ambil candlestick + hitung indikator + kirim data mentah dan seri indikator.

Parameter:
- `symbol`
- `interval`
- `limit`
- `series_points`

Output yang dikembalikan berisi:
- `raw_candles`
- `indicator_series`
- `heuristic_hints`

### `get_market_history_tokocrypto`
Ambil history multi-timeframe dan range tertentu.

Parameter:
- `symbol`
- `intervals`
- `limit_per_interval`
- `start_time_ms`
- `end_time_ms`

### `read_research_log_direct`
Baca log riset markdown historis yang disimpan di folder khusus.

### `write_research_log_direct`
Tulis log riset markdown hasil analisa.

### `self_check_tokocrypto`
Cek konektivitas langsung ke API Tokocrypto.

## Trigger manual

### Slash command
Ketik di OMP:

```text
/analisa BTC_USDT 5m 200
```

Ini akan:
- fetch data
- hitung EMA/RSI/VWAP/ATR
- run heuristik setup detection
- tampilkan hasil via `ctx.ui.notify`

### Agent prompt
Contoh prompt yang bisa dipakai oleh agent:

```text
Analisa BTC_USDT dengan data Tokocrypto langsung. Ambil candle terbaru, hitung EMA20, RSI14, VWAP, ATR14, lalu jelaskan setup yang terlihat dan raw data yang mendukungnya.
```

## Contoh output dari slash command

```text
BTC_USDT (5m) @ 68420.32
EMA20=...  RSI14=...  VWAP=...  ATR14=...
Setup: pullback_vwap_uptrend, breakout_retest
```

## Catatan penting

Kode ini sengaja dibuat agar:
- data dan indikator dikirim dalam bentuk mentah
- reasoning tetap berada di LLM/agent
- heuristic hanya bersifat hint awal, bukan keputusan final

Dengan kata lain:
- extension ini menyediakan data + alat bantu analisa
- keputusan masuk/keluar tetap berada di agent manusia atau agent AI

## Batasan / caution

- Data publik Tokocrypto bisa berubah atau endpoint bisa sedikit berbeda tergantung kebijakan server
- helper `detectSetups()` bersifat heuristik dan threshold tetap
- kode ini tidak menghubungkan ke account real trading
- tidak ada live execution / API key / signature trading di sini

## Kesimpulan

Extension `tokocrypto-direct` adalah pendekatan mandiri untuk analisis pasar crypto dari sisi data mentah dan indikator lokal, tanpa bergantung pada aplikasi lain dan tanpa kebutuhan API key pada sisi public market data.

Ini cocok untuk:
- riset market data
- evaluasi setup secara manual
- log riset agent
- reasoning berbasis raw trend dan indikator

## Lisensi

Lihat file `LICENSE` di root repo.

## Referensi cepat

- Symbol format: `BTC_USDT`
- Interval umum: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`
- Data source: Tokocrypto public API
- Model keputusan: raw data + LLM reasoning + heuristic warnings

## Tips penggunaan

Untuk analisa yang lebih kuat, gunakan kombinasi:
- timeframe kecil: `1m`, `5m`
- timeframe menengah: `15m`, `1h`
- timeframe besar: `4h`, `1d`

Jangan menilai hanya dari satu timeframe atau satu indikator saja.

## Contoh prompt lengkap

```text
Ambil candle BTC_USDT 5m terbaru, hitung EMA20, RSI14, VWAP, dan ATR14. Kirim seri mentah untuk 50 titik terakhir. Jelaskan setup yang terlihat, bandingkan dengan history 1h dan 4h, dan berikan interpretasi risikonya tanpa kesimpulan trading final.
```

Di bagian atas README ini, fokusnya adalah pada data mentah dan analisa mandiri. Bukan live execution atau keputusan otomatis.
