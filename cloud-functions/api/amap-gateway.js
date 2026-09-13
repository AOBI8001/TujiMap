// Only plain metadata is shared. Every timer and fetch belongs to the request
// awaiting it: never execute another request's closure in a Workers queue.
export const AMAP_INTERVAL_MS = 420;
export class RequestGate {
  constructor() {
    this.services = new Map();
    this.sequence = 0;
  }
  async run(
    service,
    task,
    { priority = 0, deadline = Date.now() + 12000, signal } = {},
  ) {
    let state = this.services.get(service);
    if (!state) {
      state = { nextAt: 0, active: 0, waiting: [] };
      this.services.set(service, state);
    }
    const ticket = { id: this.sequence++, priority, deadline };
    state.waiting.push(ticket);
    const queuedAt = Date.now();
    let started = false;
    try {
      while (true) {
        if (signal?.aborted) throw new Error("REQUEST_CANCELED");
        const now = Date.now();
        if (now >= deadline) throw new Error("AMAP_QUEUE_TIMEOUT");
        state.waiting = state.waiting.filter((item) => item.deadline > now);
        state.waiting.sort((a, b) => b.priority - a.priority || a.id - b.id);
        if (
          state.waiting[0] === ticket &&
          state.active < (priority < 0 ? 2 : 3) &&
          now >= state.nextAt
        ) {
          state.waiting.shift();
          state.nextAt = now + AMAP_INTERVAL_MS;
          state.active++;
          started = true;
          return await task({ queueMs: now - queuedAt, deadline });
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(100, Math.max(15, state.nextAt - now), deadline - now),
          ),
        );
      }
    } finally {
      state.waiting = state.waiting.filter((item) => item !== ticket);
      if (started) state.active--;
    }
  }
}

const serviceFor = (target) => {
  const path = new URL(target).pathname;
  if (path === "/v5/place/text") return "places";
  if (path === "/v5/direction/driving") return "driving";
  if (path === "/v5/direction/walking") return "walking";
  if (path === "/v5/direction/transit/integrated") return "transit";
  throw new Error("AMAP_ENDPOINT_NOT_ALLOWED");
};

async function execute(gate, target, options = {}, persistStart) {
  const address = new URL(target);
  if (address.origin !== "https://restapi.amap.com")
    throw new Error("AMAP_HOST_NOT_ALLOWED");
  const service = serviceFor(address);
  const deadline = Date.now() + (options.budget || 12000);
  return gate.run(
    service,
    async ({ queueMs }) => {
      if (persistStart)
        await persistStart(service, gate.services.get(service).nextAt);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.max(1, Math.min(options.timeout || 5500, deadline - Date.now())),
      );
      const started = Date.now();
      try {
        const response = await fetch(address, { signal: controller.signal });
        const raw = await response.text();
        if (!response.ok) throw new Error(`AMAP_HTTP_${response.status}`);
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error("AMAP_INVALID_RESPONSE");
        }
        return { data, timing: { queueMs, upstreamMs: Date.now() - started } };
      } catch (error) {
        if (controller.signal.aborted) error = new Error("UPSTREAM_TIMEOUT");
        error.timing = { queueMs, upstreamMs: Date.now() - started };
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { priority: options.priority || 0, deadline },
  );
}

// Cloudflare routes all isolates through one object per configured account.
// Its SQLite-backed storage only retains dispatch timestamps, never API keys,
// user searches, coordinates, response bodies or request-owned promises.
export class AmapGateway {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.gate = new RequestGate();
    ctx.blockConcurrencyWhile(async () => {
      const starts = (await ctx.storage.get("dispatch-times")) || {};
      for (const [service, nextAt] of Object.entries(starts))
        this.gate.services.set(service, { nextAt, active: 0, waiting: [] });
    });
  }
  async fetch(request) {
    try {
      const { target, options } = await request.json();
      const address = new URL(target);
      address.searchParams.set("key", this.env.AMAP_WEB_SERVICE_KEY || "");
      const result = await execute(this.gate, address, options, async () => {
        await this.ctx.storage.put(
          "dispatch-times",
          Object.fromEntries(
            [...this.gate.services].map(([service, state]) => [
              service,
              state.nextAt,
            ]),
          ),
        );
      });
      return Response.json(result);
    } catch (error) {
      // Error messages are controlled identifiers; don't expose upstream URLs.
      const code = /^(AMAP_|UPSTREAM_|REQUEST_)/.test(error.message)
        ? error.message
        : "AMAP_NETWORK_ERROR";
      return Response.json(
        { error: code, timing: error.timing },
        { status: 502 },
      );
    }
  }
}

const localGate = new RequestGate();
export async function requestAmap(env, target, options = {}) {
  if (env.AMAP_DEADLINE) {
    const remaining = env.AMAP_DEADLINE - Date.now();
    if (remaining < 100) throw new Error("UPSTREAM_TIMEOUT");
    options = {
      ...options,
      budget: Math.min(options.budget || 12000, remaining),
    };
  }
  if (!env.AMAP_GATEWAY) {
    // Local/EdgeOne fallback: safe within one process, not an account-wide gate.
    const result = await execute(localGate, target, options);
    env.AMAP_METRICS?.push(result.timing);
    return result.data;
  }
  const address = new URL(target);
  address.searchParams.delete("key");
  const stub = env.AMAP_GATEWAY.get(
    env.AMAP_GATEWAY.idFromName("amap-account-v1"),
    { locationHint: "apac" },
  );
  const response = await stub.fetch("https://amap-gateway/request", {
    method: "POST",
    body: JSON.stringify({ target: address.href, options }),
  });
  const result = await response.json();
  if (result.timing) env.AMAP_METRICS?.push(result.timing);
  if (!response.ok) throw new Error(result.error || "AMAP_NETWORK_ERROR");
  return result.data;
}
