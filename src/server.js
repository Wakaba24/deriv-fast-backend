import "dotenv/config";
import express from "express";
import cors from "cors";
import { DerivClient } from "./derivClient.js";
import { state } from "./state.js";
import { log, err } from "./logger.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

const origins = (process.env.CORS_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: origins.includes("*") ? "*" : origins,
  credentials: false
}));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    connected: state.connected,
    authorized: state.authorized,
    time: new Date().toISOString()
  });
});

app.get("/status", (req, res) => {
  res.json({
    connected: state.connected,
    authorized: state.authorized,
    lastError: state.lastError,
    defaults: state.defaults,
    ticks: {
      symbol: state.ticks.symbol,
      last: state.ticks.last,
      buffer_size: state.ticks.buffer.length
    },
    trade: {
      inProgress: state.trade.inProgress,
      queue_length: state.trade.queue.length,
      active: state.trade.active,
      lastResult: state.trade.lastResult
    }
  });
});

app.post("/set-defaults", (req, res) => {
  const { symbol, currency, basis } = req.body || {};
  if (symbol) state.defaults.symbol = String(symbol);
  if (currency) state.defaults.currency = String(currency);
  if (basis) state.defaults.basis = String(basis);
  res.json({ ok: true, defaults: state.defaults });
});

app.post("/subscribe", async (req, res) => {
  try {
    const { symbol } = req.body || {};
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol is required" });
    await client.subscribeTicks(String(symbol));
    res.json({ ok: true, symbol: String(symbol) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/trade", async (req, res) => {
  try {
    const body = req.body || {};
    const required = ["contract_type", "duration", "stake"];
    for (const k of required) {
      if (body[k] === undefined || body[k] === null || body[k] === "") {
        return res.status(400).json({ ok: false, error: `${k} is required` });
      }
    }
    const result = await client.placeTrade({
      symbol: body.symbol,
      contract_type: String(body.contract_type),
      duration: Number(body.duration),
      duration_unit: body.duration_unit ? String(body.duration_unit) : "t",
      stake: Number(body.stake),
      currency: body.currency,
      basis: body.basis,
      barrier: body.barrier,
      prediction: body.prediction
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

const port = Number(process.env.PORT || 8080);

if (!process.env.DERIV_TOKEN) {
  err("Missing DERIV_TOKEN. Set it in .env or Railway Variables.");
  process.exit(1);
}

const client = new DerivClient({
  appId: process.env.DERIV_APP_ID || "1089",
  token: process.env.DERIV_TOKEN,
  wsUrl: process.env.DERIV_WS_URL || "wss://ws.derivws.com/websockets/v3",
  pingIntervalMs: Number(process.env.PING_INTERVAL_MS || 10000),
  reconnectBaseDelayMs: Number(process.env.RECONNECT_BASE_DELAY_MS || 500),
  reconnectMaxDelayMs: Number(process.env.RECONNECT_MAX_DELAY_MS || 10000),
  tradeResultTimeoutMs: Number(process.env.TRADE_RESULT_TIMEOUT_MS || 30000),
  maxTicksBuffer: Number(process.env.MAX_TICKS_BUFFER || 2000),
  logTicks: String(process.env.LOG_TICKS || "false").toLowerCase() === "true"
});

client.connect().catch((e) => err("Initial connect failed:", e?.message || e));

app.listen(port, () => {
  log(`HTTP server listening on :${port}`);
});
