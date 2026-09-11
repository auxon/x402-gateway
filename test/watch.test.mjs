import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import app from "../src/index.ts";
import { annualProPriceCents, upsertSubscription } from "../src/plans.ts";
import {
  dueWatches,
  probeTarget,
  pruneChecks,
  resolveWatchTarget,
  runCheck,
  runWatchCron,
  validateWatchUrl,
  watchStatus,
} from "../src/watch.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");
const registrySchema = `
CREATE TABLE IF NOT EXISTS xm_services (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', manifest_url TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL DEFAULT '', network TEXT NOT NULL DEFAULT '',
  pay_to TEXT NOT NULL DEFAULT '', owner_contact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', featured INTEGER NOT NULL DEFAULT 0,
  tools_json TEXT NOT NULL DEFAULT '[]', tool_count INTEGER NOT NULL DEFAULT 0,
  paid_count INTEGER NOT NULL DEFAULT 0, free_count INTEGER NOT NULL DEFAULT 0,
  min_price_sats INTEGER, views INTEGER NOT NULL DEFAULT 0,
  reports_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT
);`;

const PAY_TO = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";
const UPSTREAM = "https://api.example.com";

function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(schema);
  raw.exec(registrySchema);
  const stmt = (sql) => {
    const s = { args: [], bind(...args) { s.args = args; return s; },
      async run() { const info = raw.prepare(sql).run(...s.args); return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }; },
      async first() { return raw.prepare(sql).get(...s.args) ?? null; },
      async all() { return { results: raw.prepare(sql).all(...s.args), success: true, meta: { changes: 0 } }; },
    };
    return s;
  };
  return { prepare: stmt, raw };
}

function makeKv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } };
}

function testEnv(db, overrides = {}) {
  return {
    DB: db,
    METER: makeKv(),
    PUBLIC_BASE: "https://gw.test/x402gateway",
    WORKERS_DEV_BASE: "https://gw.test",
    ARC_URL: "https://arc.gorillapool.io/v1",
    MAX_SERVICES_PER_IP_PER_DAY: "100",
    RATE_LIMIT_PER_MIN: "0",
    ...overrides,
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };
function makeCall(env) {
  return (path, init = {}) => app.fetch(new Request(`https://gw.test${path}`, init), env, ctx);
}

async function registerService(req, routes) {
  const res = await req("/api/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Watch Test",
      tagline: "Watchable service",
      description: "A service with a paid route",
      baseUrl: UPSTREAM,
      payTo: PAY_TO,
      ownerContact: "ops@example.com",
      routes: routes ?? [
        { name: "paid", method: "GET", path: "/v1/paid", priceSats: 20, description: "paid route" },
        { name: "free", method: "GET", path: "/v1/free", priceSats: 0, description: "free probe" },
      ],
    }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

function challenge(priceSats, payTo = PAY_TO) {
  const req = {
    x402Version: 2, scheme: "exact", network: "bsv:mainnet",
    amount: String(priceSats), payTo, asset: "native:BSV",
    resource: { url: "https://gw.test/g/s/t", description: "t", mimeType: "application/json" },
    extra: { satoshis: String(priceSats), dustFloor: "1", arcUrl: "https://arc.gorillapool.io/v1" },
  };
  return Buffer.from(JSON.stringify(req)).toString("base64");
}

/** Scripted probe responses keyed by URL substring. */
function probeStub(script) {
  return async (url) => {
    const hit = script.find(([match]) => String(url).includes(match));
    if (!hit) throw new Error(`unstubbed fetch: ${url}`);
    const [, respond] = hit;
    if (respond instanceof Error) throw respond;
    return respond;
  };
}

async function seedService(db, id = "svc_1") {
  db.raw.prepare(
    "INSERT INTO xgw_services (id, slug, name, base_url, pay_to, admin_key_hash) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, id.replace(/_/g, "-"), "Svc", UPSTREAM, PAY_TO, "hash");
}

const ok402 = (price = 20) =>
  new Response(JSON.stringify({ error: "payment_required" }), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": challenge(price) },
  });

describe("watch URL validation", () => {
  it("accepts https URLs with query strings, rejects the rest", () => {
    assert.equal(
      validateWatchUrl("https://api.example.com/v1/forecast?city=YYZ"),
      "https://api.example.com/v1/forecast?city=YYZ",
    );
    assert.throws(() => validateWatchUrl("http://api.example.com/x"), /https/);
    assert.throws(() => validateWatchUrl("https://localhost:8787/x"), /private/);
    assert.throws(() => validateWatchUrl("https://169.254.169.254/meta"), /private/);
    assert.throws(() => validateWatchUrl("not a url"), /valid/);
    assert.throws(() => validateWatchUrl(""), /required/);
  });

  it("resolves the route shorthand to the workers.dev proxy URL", () => {
    assert.equal(
      resolveWatchTarget({ route: "forecast" }, { slug: "weather" }, "https://gw.test"),
      "https://gw.test/g/weather/forecast",
    );
    assert.throws(() => resolveWatchTarget({ route: "Bad Name!" }, { slug: "s" }, "https://gw.test"), /route/);
  });
});

describe("probe evaluation", () => {
  it("accepts a valid 402 challenge and extracts price + payTo", async () => {
    const r = await probeTarget("https://api.example.com/t", true, 5000, probeStub([["/t", ok402(20)]]));
    assert.equal(r.ok, true);
    assert.equal(r.status, 402);
    assert.equal(r.priceSats, 20);
    assert.equal(r.payTo, PAY_TO);
    assert.equal(typeof r.latencyMs, "number");
  });

  it("rejects malformed challenges and wrong statuses", async () => {
    const noHeader = await probeTarget("https://x/a", true, 5000, probeStub([["/a", new Response("{}", { status: 402 })]]));
    assert.equal(noHeader.ok, false);
    assert.equal(noHeader.error, "402_without_challenge");

    const badB64 = await probeTarget("https://x/b", true, 5000, probeStub([["/b", new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": "%%%" } })]]));
    assert.equal(badB64.error, "challenge_unparseable");

    const incomplete = await probeTarget("https://x/c", true, 5000, probeStub([["/c",
      new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ nope: 1 })).toString("base64") } })]]));
    assert.equal(incomplete.error, "challenge_incomplete");

    const redirect = await probeTarget("https://x/d", true, 5000, probeStub([["/d", new Response("", { status: 302 })]]));
    assert.equal(redirect.error, "redirect_blocked");

    const serverErr = await probeTarget("https://x/e", true, 5000, probeStub([["/e", new Response("boom", { status: 500 })]]));
    assert.equal(serverErr.error, "http_500");
  });

  it("treats 200 according to expect402", async () => {
    const strict = await probeTarget("https://x/f", true, 5000, probeStub([["/f", new Response("{}", { status: 200 })]]));
    assert.equal(strict.ok, false);
    assert.equal(strict.error, "expected_402");
    const lax = await probeTarget("https://x/f", false, 5000, probeStub([["/f", new Response("{}", { status: 200 })]]));
    assert.equal(lax.ok, true);
  });

  it("reports timeouts and unreachable hosts", async () => {
    const down = await probeTarget("https://x/g", true, 5000, probeStub([["/g", new Error("fetch failed")]]));
    assert.equal(down.ok, false);
    assert.match(down.error, /unreachable/);
    const slow = await probeTarget("https://x/h", true, 5000, probeStub([["/h", Object.assign(new Error("aborted"), { name: "TimeoutError" })]]));
    assert.equal(slow.error, "timeout");
  });
});

describe("local evaluation of own routes", () => {
  it("parses self-route targets and rejects the rest", async () => {
    const { parseSelfRoute, evaluateLocalRoute } = await import("../src/watch.ts");
    assert.deepEqual(parseSelfRoute("https://gw.test/g/weather/forecast", "https://gw.test"), {
      slug: "weather", tool: "forecast",
    });
    assert.equal(parseSelfRoute("https://gw.test/g/weather/forecast/", "https://gw.test").tool, "forecast");
    assert.equal(parseSelfRoute("https://api.example.com/g/weather/forecast", "https://gw.test"), null);
    assert.equal(parseSelfRoute("https://gw.test/api/services", "https://gw.test"), null);
    assert.equal(parseSelfRoute("not a url", "https://gw.test"), null);
    void evaluateLocalRoute;
  });

  it("mirrors the proxy challenge decision without network", async () => {
    const { evaluateLocalRoute } = await import("../src/watch.ts");
    const svc = {
      slug: "s", status: "active", pay_to: PAY_TO,
      routesJson: JSON.stringify([
        { name: "paid", priceSats: 20 },
        { name: "free", priceSats: 0 },
      ]),
    };
    const ok = evaluateLocalRoute(svc, "paid", true);
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 402);
    assert.equal(ok.priceSats, 20);
    assert.equal(ok.payTo, PAY_TO);
    assert.equal(evaluateLocalRoute(svc, "free", true).error, "expected_402");
    assert.equal(evaluateLocalRoute(svc, "free", false).ok, true);
    assert.equal(evaluateLocalRoute(svc, "missing", true).error, "tool_not_found");
    assert.equal(evaluateLocalRoute({ ...svc, status: "paused" }, "paid", true).error, "service_paused");
  });

  it("prefers local evaluation over HTTP for own routes", async () => {
    const db = makeDb();
    const env = testEnv(db);
    const req = makeCall(env);
    const created = await registerService(req);
    const list = await (await req("/api/services/watch-test/watches", {
      headers: { "X-Admin-Key": created.adminKey },
    })).json();
    const id = list.watches[0].id;
    // Fetch would 522 on self-requests; local eval must win.
    const boom = () => { throw new Error("network must not be touched"); };
    const { runCheck } = await import("../src/watch.ts");
    const row = db.raw.prepare("SELECT * FROM xgw_watches WHERE id = ?").get(id);
    const outcome = await runCheck(db, row, { fetchFn: boom, workersDevBase: "https://gw.test" });
    assert.equal(outcome.watch.status, "ok");
    assert.equal(outcome.probe.priceSats, 20);
  });
});

describe("watch API", () => {
  let restore;
  beforeEach(() => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    restore = () => { globalThis.fetch = real; };
  });
  afterEach(() => restore());

  it("auto-watches the first paid route on registration", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const created = await registerService(req);
    const list = await (await req("/api/services/watch-test/watches", {
      headers: { "X-Admin-Key": created.adminKey },
    })).json();
    assert.equal(list.watches.length, 1);
    assert.equal(list.watches[0].label, "paid (auto)");
    assert.equal(list.watches[0].expect402, true);
    assert.equal(list.quota.used, 1);
    assert.equal(list.quota.max, 1);
  });

  it("requires the admin key and scopes watches to the service", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const created = await registerService(req);
    const noAuth = await req("/api/services/watch-test/watches", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://api.example.com/free" }),
    });
    assert.equal(noAuth.status, 401);
    const wrong = await req("/api/services/watch-test/watches", {
      method: "POST", headers: { "content-type": "application/json", "X-Admin-Key": "xgw_admin_nope" },
      body: JSON.stringify({ url: "https://api.example.com/free" }),
    });
    assert.equal(wrong.status, 403);
    void created;
  });

  it("enforces the free quota and raises it on Pro", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const created = await registerService(req);
    const key = created.adminKey;
    const id = env.DB.raw.prepare("SELECT id FROM xgw_services WHERE slug = ?").get("watch-test").id;

    const second = await req("/api/services/watch-test/watches", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ url: "https://api.example.com/extra" }),
    });
    assert.equal(second.status, 402);
    assert.equal((await second.json()).code, "plan_limit");

    await upsertSubscription(env.DB, {
      serviceId: id, plan: "pro", status: "active",
      stripeCustomerId: "cus_w", stripeSubscriptionId: "sub_w",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });
    for (let i = 0; i < 9; i++) {
      const res = await req("/api/services/watch-test/watches", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Admin-Key": key },
        body: JSON.stringify({ url: `https://api.example.com/extra-${i}` }),
      });
      assert.equal(res.status, 201);
    }
    const over = await req("/api/services/watch-test/watches", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ url: "https://api.example.com/one-too-many" }),
    });
    assert.equal(over.status, 402);
  });

  it("updates, pauses, checks on demand, and deletes", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const created = await registerService(req);
    const key = created.adminKey;
    const headers = { "content-type": "application/json", "X-Admin-Key": key };
    const list0 = await (await req("/api/services/watch-test/watches", { headers })).json();
    const id = list0.watches[0].id;

    const patched = await (await req(`/api/services/watch-test/watches/${id}`, {
      method: "PATCH", headers, body: JSON.stringify({ label: "renamed", paused: true }),
    })).json();
    assert.equal(patched.watch.label, "renamed");
    assert.equal(patched.watch.status, "paused");

    const check = await req(`/api/services/watch-test/watches/${id}/check`, { method: "POST", headers });
    assert.equal(check.status, 200);
    const body = await check.json();
    // Own routes evaluate locally: the paid route challenges, so the probe is
    // ok even though the watch displays paused.
    assert.equal(body.watch.status, "paused");
    assert.equal(body.transition, null);
    assert.equal(body.probe.priceSats, 20);

    const gone = await req(`/api/services/watch-test/watches/${id}`, { method: "DELETE", headers });
    assert.equal(gone.status, 200);
    const list1 = await (await req("/api/services/watch-test/watches", { headers })).json();
    assert.equal(list1.watches.length, 0);
  });

  it("serves the public status page and 404s strangers", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const created = await registerService(req);
    const list = await (await req("/api/services/watch-test/watches", {
      headers: { "X-Admin-Key": created.adminKey },
    })).json();
    const page = await req(`/watch/${list.watches[0].id}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /paid \(auto\)/);
    const missing = await req("/watch/xww_doesnotexist000000000000000000000000");
    assert.equal(missing.status, 404);
  });
});

describe("check transitions and alerting", () => {
  it("alerts on down/recovered only, and flags price changes", async () => {
    const db = makeDb();
    await seedService(db);
    const { runCheck: rc } = await import("../src/watch.ts");
    void rc;
    const env = testEnv(db);
    const { createWatch } = await import("../src/watch.ts");
    const watch = await createWatch(db, {
      serviceId: "svc_1", label: "t", targetUrl: "https://api.example.com/t",
      expect402: true, webhookUrl: "",
    });
    const okFetch = probeStub([["/t", ok402(20)]]);
    const failFetch = probeStub([["/t", new Response("boom", { status: 500 })]]);

    const { runCheck: run } = await import("../src/watch.ts");
    const first = await run(db, watch, { fetchFn: okFetch });
    assert.equal(first.watch.status, "ok");
    assert.equal(first.transition, null);

    const down = await run(db, first.watch, { fetchFn: failFetch });
    assert.equal(down.watch.status, "failing");
    assert.equal(down.transition, "down");
    assert.equal(down.watch.consecutive_failures, 1);

    const still = await run(db, down.watch, { fetchFn: failFetch });
    assert.equal(still.transition, null);
    assert.equal(still.watch.consecutive_failures, 2);

    const back = await run(db, still.watch, { fetchFn: okFetch });
    assert.equal(back.transition, "recovered");
    assert.equal(back.watch.status, "ok");

    const moved = await run(db, back.watch, { fetchFn: probeStub([["/t", ok402(30)]]) });
    assert.equal(moved.termsChanged, true);
    assert.equal(moved.transition, null);
  });
});

describe("scheduling and pruning", () => {
  it("dueWatches respects intervals and skips paused rows", async () => {
    const db = makeDb();
    await seedService(db);
    const { createWatch, dueWatches } = await import("../src/watch.ts");
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    for (const [id, checked, paused] of [["w_old", old, 0], ["w_new", recent, 0], ["w_paused", old, 1]]) {
      await createWatch(db, { serviceId: "svc_1", label: id, targetUrl: `https://api.example.com/${id}`, expect402: true, webhookUrl: "" });
      db.raw.prepare("UPDATE xgw_watches SET id = ?, last_checked_at = ?, paused = ?, status = 'ok' WHERE id LIKE 'xww_%' AND label = ?").run(id, checked, paused, id);
    }
    const due = await dueWatches(db, { freeIntervalMin: 1440, proIntervalMin: 15 });
    assert.deepEqual(due.map((d) => d.watch.id).sort(), ["w_old"]);
    assert.equal(due[0].pro, false);
  });

  it("pruneChecks drops history past retention", async () => {
    const db = makeDb();
    await seedService(db);
    const { createWatch, pruneChecks } = await import("../src/watch.ts");
    const watch = await createWatch(db, {
      serviceId: "svc_1", label: "t", targetUrl: "https://api.example.com/t",
      expect402: true, webhookUrl: "",
    });
    db.raw.prepare("INSERT INTO xgw_watch_checks (watch_id, ok, created_at) VALUES (?, 1, ?)").run(
      watch.id, new Date(Date.now() - 40 * 86400_000).toISOString());
    db.raw.prepare("INSERT INTO xgw_watch_checks (watch_id, ok, created_at) VALUES (?, 1, ?)").run(
      watch.id, new Date().toISOString());
    await pruneChecks(db, watch.id, 30);
    const left = db.raw.prepare("SELECT COUNT(*) AS n FROM xgw_watch_checks WHERE watch_id = ?").get(watch.id);
    assert.equal(left.n, 1);
  });

  it("runWatchCron checks due watches end to end", async () => {
    const db = makeDb();
    await seedService(db);
    const env = testEnv(db);
    const { createWatch, runWatchCron } = await import("../src/watch.ts");
    await createWatch(db, {
      serviceId: "svc_1", label: "t", targetUrl: "https://api.example.com/t",
      expect402: true, webhookUrl: "",
    });
    const result = await runWatchCron(env, {
      publicBase: "https://gw.test/x402gateway",
      fetchFn: probeStub([["/t", ok402(20)]]),
    });
    assert.equal(result.checked, 1);
    assert.equal(result.errors, 0);
    const row = db.raw.prepare("SELECT status, last_price_sats FROM xgw_watches LIMIT 1").get();
    assert.equal(row.status, "ok");
    assert.equal(row.last_price_sats, 20);
  });
});

describe("alert delivery", () => {
  it("POSTs webhooks and emails with the transition payload", async () => {
    const db = makeDb();
    await seedService(db);
    const { createWatch, sendWatchAlert } = await import("../src/watch.ts");
    const received = [];
    const srv = (await import("node:http")).createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        received.push({ url: req.url, body: JSON.parse(body) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const realFetch = globalThis.fetch;
    const resendCalls = [];
    globalThis.fetch = async (input, init = {}) => {
      const u = typeof input === "string" ? input : input.url;
      if (u.includes("api.resend.com")) {
        resendCalls.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "re_test" }), { status: 200 });
      }
      return realFetch(input, init);
    };
    try {
      const watch = await createWatch(db, {
        serviceId: "svc_1", label: "t", targetUrl: "https://api.example.com/t",
        expect402: true, webhookUrl: `http://127.0.0.1:${port}/hook`,
      });
      // Service row needed for the FK on createWatch above.
      const sent = await sendWatchAlert(db, {
        RESEND_API_KEY: "re_test",
        WATCH_ALERT_FROM: "Watch <w@example.com>",
      }, { ...watch, status: "failing" }, { slug: "s", name: "S", owner_contact: "ops@example.com" }, {
        type: "watch.down",
        probe: { ok: false, status: 500, latencyMs: 12, priceSats: null, payTo: null, error: "http_500" },
        statusUrl: "https://gw.test/x402gateway/watch/abc",
      });
      assert.equal(sent.email, true);
      assert.equal(sent.webhook, true);
      assert.equal(received.length, 1);
      assert.equal(received[0].body.event, "watch.down");
      assert.equal(received[0].body.watchId, watch.id);
      assert.equal(resendCalls.length, 1);
      assert.match(resendCalls[0].subject, /DOWN/);
      assert.deepEqual(resendCalls[0].to, ["ops@example.com"]);
    } finally {
      globalThis.fetch = realFetch;
      srv.close();
    }
  });

  it("skips email without a key or address, still tries webhooks", async () => {
    const db = makeDb();
    await seedService(db);
    const { createWatch, sendWatchAlert } = await import("../src/watch.ts");
    const watch = await createWatch(db, {
      serviceId: "svc_1", label: "t", targetUrl: "https://api.example.com/t",
      expect402: true, webhookUrl: "",
    });
    const sent = await sendWatchAlert(db, {}, { ...watch, status: "failing" },
      { slug: "s", name: "S", owner_contact: "not-an-email" }, {
        type: "watch.down",
        probe: { ok: false, status: null, latencyMs: 1, priceSats: null, payTo: null, error: "timeout" },
        statusUrl: "https://gw.test/x402gateway/watch/abc",
      });
    assert.deepEqual(sent, { email: false, webhook: false });
  });
});

describe("annual billing", () => {
  it("prices annual at 20% off monthly, honoring overrides", async () => {
    assert.equal(annualProPriceCents({}), 8640);
    assert.equal(annualProPriceCents({ PRO_PRICE_CENTS: "1000" }), 9600);
  });

  it("stores the interval from subscription webhooks and exposes it", async () => {
    const db = makeDb();
    const env = testEnv(db);
    const req = makeCall(env);
    const created = await registerService(req);
    const id = env.DB.raw.prepare("SELECT id FROM xgw_services WHERE slug = ?").get("watch-test").id;
    const { handleStripeEvent } = await import("../src/stripe.ts");
    await handleStripeEvent(env, {
      id: "evt_watch_annual",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_watch_1", status: "active", customer: "cus_watch_1",
          metadata: { serviceId: id, interval: "year" },
          cancel_at_period_end: false,
          items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400 }] },
        },
      },
    });
    const plan = await (await req("/api/services/watch-test/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": created.adminKey },
      body: JSON.stringify({ action: "plan" }),
    })).json();
    assert.equal(plan.plan.billingInterval, "year");
    assert.equal(plan.plan.annualPriceCents, 8640);
    assert.equal(plan.plan.active, true);
  });
});
