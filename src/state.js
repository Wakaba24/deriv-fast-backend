export const state = {
  connected: false,
  authorized: false,
  lastError: null,

  defaults: {
    symbol: process.env.DEFAULT_SYMBOL || "R_50",
    currency: process.env.DEFAULT_CURRENCY || "USD",
    basis: "stake"
  },

  ticks: {
    symbol: null,
    last: null,
    buffer: []
  },

  trade: {
    inProgress: false,
    queue: [],
    lastResult: null,
    active: null // { requestId, contractId, startedAt, payload }
  }
};
