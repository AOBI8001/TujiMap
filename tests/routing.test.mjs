import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { RequestGate } from "../cloud-functions/api/amap-gateway.js";
import { consumeDailyQuota, dailyWindow, withAiDailyQuota } from "../cloud-functions/api/ai-quota.js";

test("AI daily quota allows exactly 30 submissions and resets at Beijing midnight", () => {
  const now = Date.parse("2026-09-28T15:59:59Z");
  assert.equal(dailyWindow(now).resetAt, Date.parse("2026-09-28T16:00:00Z"));
  let state;
  for (let i = 1; i <= 40; i++) {
    const result = consumeDailyQuota(state, now);
    assert.equal(result.allowed, i <= 30);
    assert.equal(result.remaining, Math.max(0, 30 - i));
    state = result.state;
  }
  const nextDay = consumeDailyQuota(state, Date.parse("2026-09-28T16:00:00Z"));
  assert.equal(nextDay.allowed, true);
  assert.equal(nextDay.remaining, 29);
});

test("AI quota fails closed, ignores spoofable identity and leaves non-AI requests unchanged", async () => {
  let downstream = 0;
  const next = async () => { downstream++; return new Response("original", { status: 202 }); };
  const env = { DEEPSEEK_API_KEY: "quota-test-only" };
  for (const path of ["/api/ai", "/api/recognize-image"]) {
    const result = await withAiDailyQuota(new Request(`https://test.local${path}`, {
      method: "POST", headers: { "x-forwarded-for": "192.0.2.1" },
    }), env, next);
    assert.equal(result.status, 503);
  }
  assert.equal(downstream, 0);
  for (const path of ["/api/places", "/api/route", "/api/route-batch", "/api/status"]) {
    const result = await withAiDailyQuota(new Request(`https://test.local${path}`, { method: "POST" }), env, next);
    assert.equal(result.status, 202);
    assert.equal(await result.text(), "original");
  }
  assert.equal(downstream, 4);
});

test("workerd: AI quota is atomic, shared by both AI endpoints and independent per IP", { timeout: 60000 }, async () => {
  const require = createRequire(import.meta.url);
  const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
  const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(wranglerRequire.resolve("miniflare")).href);
  let upstream = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "ai-quota-regression",
    modules: ["cloudflare-worker.js", "cloud-functions/api/worker-impl.js", "cloud-functions/api/amap-gateway.js", "cloud-functions/api/image-recognition.js", "cloud-functions/api/ai-quota.js"].map(file => ({ type: "ESModule", path: resolve(file), contents: readFileSync(file, "utf8") })),
    compatibilityDate: "2026-08-25",
    bindings: { DEEPSEEK_API_KEY: "quota-test-only" },
    durableObjects: { AI_DAILY_QUOTA: { className: "AiDailyQuota", useSQLite: true } },
    outboundService: async request => {
      upstream++;
      const body = await request.json();
      const result = body.max_tokens === 2600
        ? { city: "北京", remove: [], add: [] }
        : body.max_tokens === 3000
          ? { city: "北京", places: [{ name: "故宫", role: "stop" }] }
          : { spots: [{ name: "故宫", preference: "like" }], notes: [] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
    },
  }));
  const submit = (ip, path = "/api/ai", extraHeaders = {}, body) => mf.dispatchFetch(`https://test.local${path}`, {
    method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": ip, ...extraHeaders },
    body: JSON.stringify(body || { text: "保留故宫", availableSpots: ["故宫"] }),
  });
  try {
    await mf.ready;
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => submit("192.0.2.1", "/api/ai", { "x-forwarded-for": `198.51.100.${i}` })));
    assert.equal(results.filter(r => r.status === 200).length, 30);
    assert.equal(results.filter(r => r.status === 429).length, 10);
    assert.equal(upstream, 30, "blocked requests never invoke the model");
    for (const response of results) {
      assert.equal(response.headers.get("x-ai-daily-limit"), "30");
      if (response.status === 429) assert.ok(Number(response.headers.get("retry-after")) > 0);
      await response.text();
    }
    const blockedImage = await submit("192.0.2.1", "/api/recognize-image");
    assert.equal(blockedImage.status, 429, "OCR and text share the same daily quota");
    await blockedImage.text();
    const image = await submit("192.0.2.2", "/api/recognize-image", {}, { image: "data:image/jpeg;base64,/9j/AAAA" });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("x-ai-daily-remaining"), "29");
    assert.equal((await image.json()).places.length, 1);
    assert.equal(upstream, 32, "two image passes consume one visitor submission");
    const text = await submit("192.0.2.2");
    assert.equal(text.status, 200);
    assert.equal(text.headers.get("x-ai-daily-remaining"), "28");
    await text.text();
    const invalid = await submit("192.0.2.2", "/api/ai", {}, {});
    assert.equal(invalid.status, 400, "original API status is preserved");
    assert.equal(invalid.headers.get("x-ai-daily-remaining"), "27");
    await invalid.text();
    const status = await mf.dispatchFetch("https://test.local/api/status", { headers: { "CF-Connecting-IP": "192.0.2.1" } });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("x-ai-daily-limit"), null);
    await status.text();
  } finally {
    await mf.dispose();
  }
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const peakQps = (starts) =>
  Math.max(
    0,
    ...starts.map(
      (at) => starts.filter((other) => other >= at && other < at + 1000).length,
    ),
  );

test("dispatch rate and in-flight concurrency are independent; canceled tickets are removed", async () => {
  const gate = new RequestGate(),
    starts = [];
  let active = 0,
    maxActive = 0;
  const begin = Date.now();
  await Promise.all(
    Array.from({ length: 6 }, () =>
      gate.run("drive", async () => {
        starts.push(Date.now());
        maxActive = Math.max(maxActive, ++active);
        await wait(800);
        --active;
      }),
    ),
  );
  assert.ok(peakQps(starts) <= 3);
  assert.ok(maxActive >= 2 && maxActive <= 3);
  assert.ok(
    Date.now() - begin < 4200,
    "must not serialize six 800 ms responses",
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    gate.run("drive", () => assert.fail("canceled request dispatched"), {
      signal: abort.signal,
    }),
  );
  assert.equal(gate.services.get("drive").waiting.length, 0);
});

test("interactive search bypasses queued background photo lookup", async () => {
  const gate = new RequestGate(),
    order = [];
  const run = (id, priority) =>
    gate.run(
      "places",
      () => {
        order.push(id);
      },
      { priority },
    );
  const first = run("first", 0);
  const photo = run("photo", -10);
  const search = run("search", 20);
  await Promise.all([first, photo, search]);
  assert.deepEqual(order, ["first", "search", "photo"]);
  await assert.rejects(
    gate.run("places", () => assert.fail("expired task dispatched"), {
      deadline: Date.now() - 1,
    }),
  );
});

// Use production functions and bundled city data, not a rewritten test algorithm.
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const importTs = async (source) =>
  import(
    "data:text/javascript;base64," +
      Buffer.from(
        ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText,
      ).toString("base64")
  );
const math = app.slice(
  app.indexOf("function coords("),
  app.indexOf("function attractionStem("),
);
const grouping = app.slice(
  app.indexOf("function orderStops("),
  app.indexOf("function tentativePlace("),
);
const { groupByDay } = await importTs(
  math + grouping + "\nexport { groupByDay };",
);
const { CITIES } = await importTs(
  readFileSync(new URL("../src/data.ts", import.meta.url), "utf8"),
);
for (const [cityId, n, days] of [
  ["beijing", 15, 1],
  ["chongqing", 45, 3],
  ["shanghai", 35, 7],
  ["chongqing", 28, 7],
]) {
  test(`balanced grouping: ${cityId}, ${days} days, up to ${n} stops`, () => {
    const city = CITIES.find((city) => city.id === cityId),
      spots = city.spots.slice(0, n);
    const endpoints = Array.from({ length: days }, () => ({
      origin: city.defaultStart,
      destination: city.defaultStart,
    }));
    const start = performance.now();
    const groups = groupByDay(spots, days, endpoints, {}, true);
    assert.equal(groups.flat().length, spots.length);
    assert.equal(
      new Set(groups.flat().map((spot) => spot.id)).size,
      spots.length,
    );
    assert.ok(
      Math.max(...groups.map((group) => group.length)) -
        Math.min(...groups.map((group) => group.length)) <=
        1,
    );
    assert.ok(performance.now() - start < 1000);
    const locks = Object.fromEntries(
      spots.slice(0, Math.min(8, spots.length)).map((spot) => [spot.id, 1]),
    );
    const locked = groupByDay(spots, days, endpoints, locks, true);
    assert.ok(
      Object.keys(locks).every((id) =>
        locked[0].some((spot) => spot.id === id),
      ),
    );
  });
}

test(
  "workerd: real Durable Object, concurrent requests, mixed batches, cache and permanent errors",
  { timeout: 60000 },
  async () => {
    const require = createRequire(import.meta.url);
    const wranglerRequire = createRequire(
      require.resolve("wrangler/package.json"),
    );
    const { Miniflare, convertV4MiniflareOptions } = await import(
      pathToFileURL(wranglerRequire.resolve("miniflare")).href
    );
    const dispatches = [];
    const modules = [
      "cloudflare-worker.js",
      "cloud-functions/api/worker-impl.js",
      "cloud-functions/api/amap-gateway.js",
      "cloud-functions/api/image-recognition.js",
      "cloud-functions/api/ai-quota.js",
    ].map((file) => ({
      type: "ESModule",
      path: resolve(file),
      contents: readFileSync(file, "utf8"),
    }));
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        name: "routing-regression",
        modules,
        compatibilityDate: "2026-08-25",
        bindings: { AMAP_WEB_SERVICE_KEY: "mock-test-key" },
        durableObjects: {
          AMAP_GATEWAY: { className: "AmapGateway", useSQLite: true },
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          dispatches.push({
            path: url.pathname,
            at: Date.now(),
            origin: url.searchParams.get("origin"),
          });
          await wait(500);
          if (url.searchParams.get("origin") === "0,0")
            return Response.json({
              status: "0",
              info: "OVER_DIRECTION_RANGE",
              infocode: "20800",
            });
          const path = {
            distance: "100",
            cost: { duration: "60" },
            steps: [
              {
                instruction: "步行100米",
                polyline: "116.39,39.9;116.40,39.91",
              },
            ],
          };
          return Response.json({
            status: "1",
            pois: [],
            route: {
              paths: [path],
              transits: [
                {
                  ...path,
                  segments: [{ walking: { ...path, distance: "100" } }],
                },
              ],
            },
          });
        },
      }),
    );
    try {
      await mf.ready;
      const searchResponses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          mf.dispatchFetch(
            `https://test.local/api/places?city=北京&keywords=case${i}`,
          ),
        ),
      );
      assert.deepEqual(
        searchResponses.map((response) => response.status),
        [200, 200, 200, 200, 200, 200],
      );
      await Promise.all(searchResponses.map((response) => response.text()));
      const items = Array.from({ length: 12 }, (_, i) => ({
        id: String(i),
        origin: `116.${39000 + Math.floor(i / 3)},39.9`,
        destination: "116.40,39.91",
        mode: ["driving", "transit", "walking"][i % 3],
      }));
      const batch = async (items) => {
        const response = await mf.dispatchFetch(
          "https://test.local/api/route-batch",
          { method: "POST", body: JSON.stringify({ city: "010", items }) },
        );
        assert.equal(response.status, 200);
        return response.json();
      };
      const first = await batch(items);
      assert.equal(first.results.filter((result) => result.ok).length, 12);
      assert.ok(first.elapsedMs < 4000);
      const before = dispatches.length;
      const cached = await batch(items);
      assert.equal(
        dispatches.length,
        before,
        "cache repeat must not call upstream",
      );
      assert.equal(cached.results.filter((result) => result.ok).length, 12);
      assert.ok(
        cached.results.every((result) =>
          ["edge", "hit"].includes(result.cache),
        ),
      );
      assert.ok(
        cached.results.some((result) => result.cache === "edge"),
        "batch must read the edge cache, not just process memory",
      );
      const parallel = await Promise.all(
        [1, 2].map((offset) =>
          batch(
            items.map((item) => ({
              ...item,
              origin: `116.${41000 + offset * 100 + Number(item.id)},39.9`,
            })),
          ),
        ),
      );
      assert.ok(
        parallel.every((result) => result.results.every((item) => item.ok)),
        "independent batches must finish without crossing request-owned I/O",
      );
      const bad = await batch([
        {
          id: "range",
          origin: "0,0",
          destination: "116.40,39.91",
          mode: "walking",
        },
      ]);
      assert.equal(bad.results[0].ok, false);
      assert.equal(
        dispatches.filter((item) => item.origin === "0,0").length,
        1,
        "permanent errors must not retry",
      );
      for (const path of new Set(dispatches.map((item) => item.path)))
        assert.ok(
          peakQps(
            dispatches
              .filter((item) => item.path === path)
              .map((item) => item.at),
          ) <= 3,
          `${path} exceeded 3 QPS`,
        );
    } finally {
      await mf.dispose();
    }
  },
);
