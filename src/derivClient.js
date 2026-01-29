import WebSocket from "ws";
import { state } from "./state.js";
import { log, warn, err } from "./logger.js";

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export class DerivClient {
  constructor(opts) {
    this.appId = opts.appId;
    this.token = opts.token;
    this.wsUrl = opts.wsUrl;
    this.pingIntervalMs = opts.pingIntervalMs;
    this.reconnectBaseDelayMs = opts.reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = opts.reconnectMaxDelayMs;
    this.tradeResultTimeoutMs = opts.tradeResultTimeoutMs;
    this.maxTicksBuffer = opts.maxTicksBuffer;
    this.logTicks = opts.logTicks;

    this.ws = null;
    this.pingTimer = null;
    this.reconnectAttempt = 0;

    this.pending = new Map(); // req_id -> {resolve,reject,ts,type}
  }

  _nextReqId() {
    return Math.floor(Math.random() * 1e9);
  }

  async connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    state.connected = false;
    state.authorized = false;

    const url = `${this.wsUrl}?app_id=${encodeURIComponent(this.appId)}`;
    log("Connecting to Deriv WS:", url);

    this.ws = new WebSocket(url);

    this.ws.on("open", async () => {
      state.connected = true;
      state.lastError = null;
      this.reconnectAttempt = 0;
      log("✅ Connected");

      // Start heartbeat
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ ping: 1 }));
        }
      }, this.pingIntervalMs);

      // Authorize
      try {
        await this.send({ authorize: this.token }, "authorize");
        state.authorized = true;
        log("🔐 Authorized");
        // Subscribe to default ticks
        await this.subscribeTicks(state.defaults.symbol);
      } catch (e) {
        err("Authorize failed:", e?.message || e);
        state.lastError = e?.message || String(e);
      }
    });

    this.ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }

      // Resolve pending promises by req_id
      if (msg.req_id && this.pending.has(msg.req_id)) {
        const p = this.pending.get(msg.req_id);
        this.pending.delete(msg.req_id);
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg);
      }

      // Stream handlers
      if (msg.msg_type === "tick") {
        state.ticks.symbol = msg.tick?.symbol || state.ticks.symbol;
        state.ticks.last = msg.tick;
        state.ticks.buffer.push(msg.tick);
        if (state.ticks.buffer.length > this.maxTicksBuffer) {
          state.ticks.buffer.splice(0, state.ticks.buffer.length - this.maxTicksBuffer);
        }
        if (this.logTicks) log("tick", msg.tick.quote, msg.tick.epoch);
      }

      if (msg.msg_type === "buy") {
        // buy response gives contract_id
        if (state.trade.active && msg.buy?.contract_id) {
          state.trade.active.contractId = msg.buy.contract_id;
        }
      }

      if (msg.msg_type === "proposal_open_contract") {
        // Final result processing
        const poc = msg.proposal_open_contract;
        if (!poc) return;
        const active = state.trade.active;
        if (!active || active.contractId !== poc.contract_id) return;

        // Mark as final when is_sold or status indicates settled
        const isFinal = Boolean(poc.is_sold) || ["won", "lost"].includes(poc.status);
        if (isFinal) {
          state.trade.lastResult = {
            contract_id: poc.contract_id,
            status: poc.status,
            is_sold: poc.is_sold,
            profit: poc.profit,
            payout: poc.payout,
            buy_price: poc.buy_price,
            sell_price: poc.sell_price,
            exit_tick: poc.exit_tick,
            exit_tick_time: poc.exit_tick_time,
            transaction_ids: poc.transaction_ids || null,
            endedAt: Date.now()
          };
          this._finishTrade();
        }
      }

      if (msg.error) {
        state.lastError = `${msg.error.code}: ${msg.error.message}`;
      }
    });

    this.ws.on("close", async (code, reason) => {
      state.connected = false;
      state.authorized = false;
      warn("WS closed:", code, reason?.toString?.() || "");

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;

      // Reject all pending
      for (const [_, p] of this.pending.entries()) {
        p.reject(new Error("WebSocket closed"));
      }
      this.pending.clear();

      // Auto reconnect
      await this._reconnect();
    });

    this.ws.on("error", (e) => {
      state.lastError = e?.message || String(e);
      warn("WS error:", state.lastError);
    });
  }

  async _reconnect() {
    this.reconnectAttempt += 1;
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * Math.pow(2, Math.min(this.reconnectAttempt, 8))
    );
    warn(`Reconnecting in ${delay}ms...`);
    await sleep(delay);
    try {
      await this.connect();
    } catch (e) {
      warn("Reconnect failed:", e?.message || e);
    }
  }

  async send(payload, type = "request") {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not open");
    }
    const req_id = this._nextReqId();
    const msg = { ...payload, req_id };
    const p = new Promise((resolve, reject) => {
      this.pending.set(req_id, { resolve, reject, ts: Date.now(), type });
      // safety timeout
      setTimeout(() => {
        if (this.pending.has(req_id)) {
          this.pending.delete(req_id);
          reject(new Error(`Timeout waiting for ${type}`));
        }
      }, 15000);
    });
    this.ws.send(JSON.stringify(msg));
    return p;
  }

  async subscribeTicks(symbol) {
    // unsubscribe previous if needed by forgetting old stream (simple approach)
    state.ticks.symbol = symbol;
    state.ticks.buffer = [];
    await this.send({ ticks: symbol, subscribe: 1 }, "ticks_subscribe");
    log("📈 Subscribed ticks:", symbol);
  }

  async placeTrade(tradePayload) {
    // Queue if in progress
    const requestId = this._nextReqId();
    const payload = { requestId, ...tradePayload };
    if (state.trade.inProgress) {
      state.trade.queue.push(payload);
      return { accepted: true, queued: true, request_id: requestId, queue_position: state.trade.queue.length };
    }

    // Start immediately
    await this._startTrade(payload);
    return { accepted: true, queued: false, request_id: requestId };
  }

  async _startTrade(payload) {
    if (!state.authorized) throw new Error("Not authorized yet");
    state.trade.inProgress = true;
    state.trade.active = { requestId: payload.requestId, contractId: null, startedAt: Date.now(), payload };

    const {
      symbol,
      contract_type,
      duration,
      duration_unit,
      stake,
      currency,
      basis,
      barrier,
      prediction
    } = payload;

    // 1) Create proposal (fast, minimal)
    const proposalReq = {
      proposal: 1,
      amount: Number(stake),
      basis: basis || state.defaults.basis || "stake",
      contract_type,
      currency: currency || state.defaults.currency,
      duration: Number(duration),
      duration_unit: duration_unit || "t",
      symbol: symbol || state.defaults.symbol
    };

    if (barrier !== undefined && barrier !== null) proposalReq.barrier = String(barrier);
    if (prediction !== undefined && prediction !== null) proposalReq.prediction = Number(prediction);

    const proposalRes = await this.send(proposalReq, "proposal");
    const proposal_id = proposalRes.proposal?.id;
    if (!proposal_id) throw new Error("No proposal id returned");

    // 2) Buy
    const buyRes = await this.send({ buy: proposal_id, price: Number(stake) }, "buy");
    const contractId = buyRes.buy?.contract_id;
    if (!contractId) throw new Error("No contract_id returned");

    state.trade.active.contractId = contractId;

    // 3) Subscribe to open contract updates for this contract_id
    await this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }, "proposal_open_contract");

    // 4) Timeout safety (avoid stuck lock)
    setTimeout(() => {
      const active = state.trade.active;
      if (active && active.contractId === contractId && state.trade.inProgress) {
        state.trade.lastResult = {
          contract_id: contractId,
          status: "timeout",
          is_sold: false,
          profit: null,
          payout: null,
          buy_price: null,
          sell_price: null,
          endedAt: Date.now()
        };
        this._finishTrade();
      }
    }, this.tradeResultTimeoutMs);

    log("🟢 Trade started:", { contract_type, symbol: proposalReq.symbol, stake, duration: proposalReq.duration, contractId });
  }

  _finishTrade() {
    const finished = state.trade.active;
    state.trade.active = null;
    state.trade.inProgress = false;

    // Start next queued trade if exists
    const next = state.trade.queue.shift();
    if (next) {
      this._startTrade(next).catch((e) => {
        err("Next trade failed:", e?.message || e);
        state.trade.lastResult = { contract_id: null, status: "error", error: e?.message || String(e), endedAt: Date.now() };
        // ensure unlock and continue
        state.trade.active = null;
        state.trade.inProgress = false;
      });
    } else {
      log("✅ Trade finished:", state.trade.lastResult);
    }
  }
}
