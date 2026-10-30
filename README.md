# prun-price-fit

A daily, fully automated **price-fitting board** for Prosperous Universe (read-only, public data only).

Idea: switching production in PrUn costs almost nothing, so any publicly visible margin gets arbitraged
away by supply. This project fits **future CX prices** against a feature set built from
(1) a materials cost anchor, (2) a labour cost anchor, (3) production-chain structure, and
(4) market structure - all recomputed from public data every day.

- Board: `site/index.html`
- Per-material page: `site/detail.html?t=TICKER` - game-style candlestick chart + cost-anchor breakdown

## Pipeline

| step | file | what it does |
|---|---|---|
| 1 | `tools/pull-cxpc.mjs` | pulls the whole daily price history (~3.2 years, ~630k rows) from the public PRUNplanner mirror of FIO game data |
| 2 | `tools/build-dataset.mjs` | joins it with `recipes` / `buildings` / `materials`; computes materials cost anchor and labour cost anchor per unit, plus forward returns |
| 3 | `tools/analyze.mjs` | cross-sectional IC study (price target, 30/90 day horizons), today's board, per-material OHLCV payload for the charts |
| 4 | `.github/workflows/daily.yml` | runs 1-3 daily and publishes `site/` to GitHub Pages |

Nothing is written back upstream, no account or API key is used, and the game itself is never touched.

## Cost anchors

- **Materials**: cheapest producing recipe for the same exchange, priced on the same day (covers ~78% of rows).
- **Labour** (`tools/baskets.mjs`): consumption per 100 workers per day, times the building's workforce,
  times the recipe duration, divided by output.
  - Pioneers / Settlers baskets are verified against the official handbook (`wiki/efficiency-factors`).
  - Technicians / Engineers / Scientists baskets are derived from the game's own population-bundle
    recipes (PAC -> TBU/CBU/EBU), divided by 10 to get a day, excluding the polymer input (PE).
  - Depreciation and taxes are **not** included.


## In-game official inflation index (INFL)

`INFL` only exists inside the game client - there is no public API - so it is captured read-only
through the game client and stored in `site/infl/infl-history.json` (committed, tiny, grows slowly).

How the capture works (all read-only, no game state is ever changed):

1. Open the game in a browser with a debugging port and attach over CDP.
2. Install a capture hook at document start (`Page.addScriptToEvaluateOnNewDocument`) that wraps
   `WebSocket`, `XMLHttpRequest` and `fetch` and records frames in `window.__cap`, then reload.
3. Send the same request the client sends (socket.io frame format):

   ```json
   42["message",{
     "to": "inflation-index",
     "messageType": "INFLATION_INDEX_GET_DATA",
     "payload": { "instanceId": "<uuid>", "interval": "MONTH", "range": 12,
                  "currency": "NCC", "materials": [], "actionId": "<uuid>" },
     "contextId": "<client context id>"
   }]
   ```

   - `interval`: `DAY` (range 45) / `MONTH` (range 12) / `YEAR` (range 10) - the enums the client uses.
   - `materials: []` means "all materials"; the client can also pass material ids for a category/basket.
   - The reply is an `ACTION_COMPLETED` event whose message is `INFLATION_INDEX_DATA` with
     `{ instanceId, currency, interval, points: [{ periodStart, level, rate }] }`.
   - `level` is the index with the first period = 1.0; `rate` is that period's change.

4. Merge the points into `site/infl/infl-history.json` (keyed by currency + interval, deduped by
   `periodStart`, so repeated captures extend the daily history).

The index only starts around 2026-06, so the history is short today: monthly has 3 points,
daily has 45. Capturing regularly is what makes it valuable over time.

### Official INFL vs the measured inflation on the board

The board also computes a "measured" inflation (median price change per currency, trailing 365 days).
They differ because the official index uses the game's own basket/weighting, while the measured one is
a median across traded materials. As of 2026-10-12:

| currency | official INFL (latest month) | official, annualised | measured (365d) |
|---|---|---|---|
| AIC | +2.64% | ~37%/yr | 21.8% |
| CIS | +4.37% | ~67%/yr | 21.7% |
| ICA | +2.84% | ~40%/yr | 29.9% |
| NCC | +3.84% | ~57%/yr | 24.3% |


## Polite API usage (per the PRUNplanner API author's request)

The API author asked for gentler traffic. The puller therefore:

- fetches **one bulk request per day**: `GET /data/cxpc/daily/?days=3` (all exchanges, ~1.5k rows),
  instead of 370 per-ticker requests. That is **1 request/day instead of ~740**.
- keeps history as **monthly files** in `data/history/YYYY-MM.jsonl.gz` (committed). The daily job
  merges the 3-day slice into the current month file and rebuilds the combined data file; old months never change.
- sends a contactable User-Agent: `prun-price-fit/1.0 (https://github.com/mlml22/prun-price-fit)`.
- makes sequential requests with a 1.5 s pause and honours `Retry-After` on 429/5xx.
- runs **once a day** (08:08 Beijing = 00:08 UTC).

Backfill (rare, only when `data/history/` is empty) pages `since`/`until` in <=31-day windows per exchange:

```bash
node tools/pull-cxpc.mjs --backfill   # paged, sequential, ~150 requests total
node tools/pull-cxpc.mjs --rebuild    # rebuild data/cxpc-daily.jsonl.gz from month files
node tools/pull-cxpc.mjs              # daily incremental (default)
```

## Data sources (public, no auth)

- `https://api.prunplanner.org/data/cxpc/{TICKER}/` - daily OHLCV history (FIO-imported game record)
- `https://api.prunplanner.org/data/recipes/`, `/buildings/`, `/materials/` - game structure
- `https://handbook.apex.prosperousuniverse.com/wiki/efficiency-factors/` - official consumables rates

## Honest caveats

- Only days with trades exist upstream, so thin markets have gappy series (survivorship-like bias).
- Overlapping forward windows inflate t-statistics; treat IC values as exploratory.
- Order-book depth / MM quotes have no history upstream, so they cannot be backtested.
- The board score is a transparent heuristic, not a validated model.
