# Deriv Fast Backend (Headless Executor)

This is a **fast, always-on backend** for Deriv/DBot-style strategies (Jump/Volatility, digit contracts, etc.).
It keeps **one persistent WebSocket** to Deriv, sends **ping heartbeats**, and executes trades via a **single-trade lock + queue**
to avoid "confusion" from late results.

## What you connect from Antigravity (UI)
Your Antigravity app should:
- do analysis/pattern detection/UI
- call this backend to **execute** trades
- optionally poll `/status` or connect to SSE later (kept simple here)

## Quick Start (local)
1) Install Node.js 18+.
2) In this folder:
   ```bash
   npm install
   ```
3) Copy `.env.example` to `.env` and set `DERIV_TOKEN`.
4) Run:
   ```bash
   npm start
   ```
5) Open health check:
   - http://localhost:8080/health

## Deploy on Railway (fast + stable)
1) Create a GitHub repo with these files and push.
2) Railway → New Project → Deploy from GitHub.
3) Add Variables in Railway:
   - `DERIV_TOKEN` (required)
   - `DERIV_APP_ID` (optional)
   - `CORS_ORIGINS` (set to your UI domain later)
4) Deploy. Check Logs for:
   - "Connected"
   - "Authorized"

## API (what your UI calls)

### POST /trade
Executes one trade (queued if one is running).
Body example:
```json
{
  "symbol": "R_50",
  "contract_type": "DIGITEVEN",
  "duration": 3,
  "duration_unit": "t",
  "stake": 0.35,
  "currency": "USD"
}
```

Optional fields:
- `barrier`, `prediction`, `basis` ("stake" or "payout")

Returns:
- accepted + request_id
- later you can poll `/status` to see last trade results.

### GET /status
Returns connection state, last tick, last trade result, queue length.

### POST /set-defaults
Set defaults to reduce payload from UI.
Body example:
```json
{ "symbol": "R_50", "currency": "USD" }
```

## Notes for fast bots
- Do NOT place trades on every tick; use your strategy signals.
- Keep UI lightweight; avoid per-tick rerenders.
- This backend already:
  - pings every 10s
  - reconnects with backoff
  - enforces single active trade
  - tracks contract_id and waits for final result (with timeout)

## Integrating with Antigravity
In your Antigravity code, when your conditions trigger, call:

```js
await fetch("https://YOUR-RAILWAY-URL/trade", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    symbol: "R_50",
    contract_type: "DIGITODD",
    duration: 3,
    duration_unit: "t",
    stake: 0.35,
    currency: "USD"
  })
});
```

If you want, you can also call `/status` every 0.5–1s to update UI.

---
