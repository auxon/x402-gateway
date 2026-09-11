import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { P2PKH, Script, Transaction } from "@bsv/sdk";
import app from "../src/index.ts";
import {
  isPrivateHost,
  parseBaseUrl,
  slugify,
  validateServiceInput,
} from "../src/store.ts";
import { b64decodeJson, b64encodeJson } from "../src/x402.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");

const PAY_TO = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";
const UPSTREAM = "https://api.example.com";

// ---------- fake D1 over node:sqlite ----------

// Minimal mirror of x402market/schema.sql (the shared table the gateway writes).
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

function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(schema);
  raw.exec(registrySchema);
  let nextRowid = 1;
  const stmt = (sql) => {
    const s = { args: [], bind(...args) { s.args = args; return s; },
      async run() { const info = raw.prepare(sql).run(...s.args); return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }; },
      async first() { return raw.prepare(sql).get(...s.args) ?? null; },
      async all() { return { results: raw.prepare(sql).all(...s.args), success: true, meta: { changes: 0 } }; },
    };
    return s;
  };
  return { prepare: stmt, raw, _bump: () => nextRowid++ };
}

// ---------- KV stub ----------

function makeKv() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
  };
}

function testEnv(db) {
  return {
    DB: db,
    METER: makeKv(),
    PUBLIC_BASE: "https://gw.test/x402gateway",
    WORKERS_DEV_BASE: "https://gw.test",
    ARC_URL: "https://arc.gorillapool.io/v1",
    MAX_ROUTES_PER_SERVICE: "20",
    MAX_SERVICES_PER_IP_PER_DAY: "100",
    RATE_LIMIT_PER_MIN: "0",
    UPSTREAM_TIMEOUT_MS: "5000",
  };
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

function makeCall(env) {
  return (path, init = {}) => app.fetch(new Request(`https://gw.test${path}`, init), env, ctx);
}

// ---------- fetch stubs ----------

let arcCounter = 0xa0;
function fakeTxid() {
  arcCounter += 1;
  return arcCounter.toString(16).padStart(64, "a").slice(0, 64);
}

let upstreamCalls = [];
function installFetchStub() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const isRequest = typeof input !== "string";
    const u = isRequest ? input.url : String(input);
    const method = init.method ?? (isRequest ? input.method : "GET");
    let bodyText = init.body != null ? String(init.body) : null;
    if (bodyText === null && isRequest && method !== "GET" && method !== "HEAD") {
      bodyText = await input.clone().text();
    }
    if (u.includes("arc.gorillapool")) {
      return new Response(JSON.stringify({ txid: fakeTxid() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.startsWith(UPSTREAM)) {
      upstreamCalls.push({ url: u, init });
      return new Response(JSON.stringify({ upstream: true, url: u, auth: init.headers?.get?.("authorization") ?? null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return real(url, init);
  };
  return () => {
    globalThis.fetch = real;
  };
}

function buildTxHex(tag, sats = 100) {
  const tx = new Transaction();
  const src = Buffer.from(`${tag}:gateway-test`).toString("hex").padEnd(64, "0").slice(0, 64);
  tx.addInput({ sourceTXID: src, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new Script() });
  tx.addOutput({ lockingScript: new P2PKH().lock(PAY_TO), satoshis: sats });
  tx.addOutput({ lockingScript: new P2PKH().lock(PAY_TO), satoshis: 50 });
  return tx.toHex();
}

function sigFor(tag, sats = 100) {
  return b64encodeJson({
    x402Version: 2,
    scheme: "exact",
    network: "bsv:mainnet",
    txHex: buildTxHex(tag, sats),
    encoding: "raw-hex",
  });
}

async function registerService(req, overrides = {}) {
  const res = await req("/api/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Example API",
      tagline: "Test service for the gateway",
      description: "Testing",
      baseUrl: UPSTREAM,
      payTo: PAY_TO,
      ownerContact: "ops@example.com",
      authHeader: "Authorization",
      authValue: "Bearer secret",
      routes: [
        { name: "quote", method: "GET", path: "/v1/quote", priceSats: 25, description: "A paid quote" },
        { name: "ping", method: "GET", path: "/ping", priceSats: 0, description: "Free ping" },
      ],
      ...overrides,
    }),
  });
  return res;
}

// ---------- tests ----------

describe("mounts", () => {
  it("serves trailing-slash variants without 404s", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    for (const path of ["/x402gateway/", "/x402gateway/dashboard/", "/x402gateway/health/", "/x402gateway/api/services/"]) {
      const res = await req(path);
      assert.equal(res.status, 200, path);
    }
    const withQuery = await req("/x402gateway/?upgrade=success&service=demo");
    assert.equal(withQuery.status, 200);
  });

  it("serves the same API under the /x402gateway prefix", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const health = await req("/x402gateway/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "x402-gateway");
    await registerService(req);
    const manifest = await req("/x402gateway/g/example-api/manifest");
    assert.equal(manifest.status, 200);
  });
});

describe("validation", () => {
  it("accepts a clean service input", () => {
    const input = validateServiceInput(
      {
        name: "Weather",
        baseUrl: "https://api.weather.example/v1",
        payTo: PAY_TO,
        routes: [{ name: "forecast", method: "GET", path: "/forecast", priceSats: 10, description: "x" }],
      },
      20,
    );
    assert.equal(input.baseUrl, "https://api.weather.example/v1");
    assert.equal(input.routes.length, 1);
    assert.equal(input.routes[0].priceSats, 10);
  });

  it("rejects http, private hosts, credentials, and bad payTo", () => {
    assert.throws(() => parseBaseUrl("http://api.example.com"), /https/);
    assert.throws(() => parseBaseUrl("https://localhost:8080"), /private or local/);
    assert.throws(() => parseBaseUrl("https://192.168.1.10"), /private or local/);
    assert.throws(() => parseBaseUrl("https://user:pass@api.example.com"), /credentials/);
    assert.equal(isPrivateHost(new URL("https://169.254.169.254")), true);
    assert.equal(isPrivateHost(new URL("https://[::1]")), true);
    assert.equal(isPrivateHost(new URL("https://[fd00::1]")), true);
    assert.equal(isPrivateHost(new URL("https://api.example.com")), false);
    assert.throws(
      () => validateServiceInput({ name: "Test", baseUrl: UPSTREAM, payTo: "nope", routes: [{ name: "a", method: "GET", path: "/", priceSats: 1 }] }, 20),
      /payTo/,
    );
  });

  it("rejects reserved, duplicate, and malformed routes", () => {
    const base = { name: "Test Service", baseUrl: UPSTREAM, payTo: PAY_TO };
    assert.throws(() => validateServiceInput({ ...base, routes: [] }, 20), /at least one route/);
    assert.throws(
      () => validateServiceInput({ ...base, routes: [{ name: "manifest", method: "GET", path: "/", priceSats: 1 }] }, 20),
      /reserved/,
    );
    assert.throws(
      () =>
        validateServiceInput(
          {
            ...base,
            routes: [
              { name: "a", method: "GET", path: "/a", priceSats: 1 },
              { name: "a", method: "GET", path: "/b", priceSats: 1 },
            ],
          },
          20,
        ),
      /duplicate/,
    );
    assert.throws(
      () => validateServiceInput({ ...base, routes: [{ name: "a", method: "DELETE", path: "/a", priceSats: 1 }] }, 20),
      /method/,
    );
    assert.throws(
      () => validateServiceInput({ ...base, routes: [{ name: "a", method: "GET", path: "/../secrets", priceSats: 1 }] }, 20),
      /\.\./,
    );
    assert.throws(
      () => validateServiceInput({ ...base, routes: [{ name: "a", method: "GET", path: "/a", priceSats: -1 }] }, 20),
      /priceSats/,
    );
  });

  it("slugifies names deterministically", () => {
    assert.equal(slugify("Weather Oracle!"), "weather-oracle");
    assert.equal(slugify("  ---  "), "");
  });
});

describe("registration", () => {
  let restore;
  beforeEach(() => {
    restore = installFetchStub();
    upstreamCalls = [];
  });
  afterEach(() => restore());

  it("registers, returns the admin key once, and auto-lists in x402market", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const res = await registerService(req);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.adminKey.startsWith("xgw_admin_"));
    assert.equal(body.service.slug, "example-api");
    assert.equal(body.listing.ok, true);
    assert.ok(body.listing.serviceId);
    assert.equal(body.gatewayBase, "https://gw.test/x402gateway/g/example-api");

    // The listing is written straight into the shared registry table.
    const listed = await (await req("/api/services/example-api")).json();
    assert.ok(listed.service.registryId);
    const row = env.DB.raw
      .prepare("SELECT status, pay_to, tool_count, paid_count, min_price_sats, manifest_url FROM xm_services WHERE manifest_url = ?")
      .get("https://gw.test/g/example-api/manifest");
    assert.equal(row.status, "verified");
    assert.equal(row.pay_to, PAY_TO);
    assert.equal(row.tool_count, 2);
    assert.equal(row.paid_count, 1);
    assert.equal(row.min_price_sats, 25);

    // Secrets never come back out.
    const detail = await (await req("/api/services/example-api")).json();
    assert.equal(detail.service.authValue, undefined);
    assert.equal(JSON.stringify(detail).includes("Bearer secret"), false);
  });

  it("serves a registry-ready manifest with absolute tool paths", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    await registerService(req);
    const manifest = await (await req("/g/example-api/manifest")).json();
    assert.equal(manifest.name, "Example API");
    assert.equal(manifest.x402.payTo, PAY_TO);
    assert.equal(manifest.tools.length, 2);
    assert.equal(manifest.tools[0].path, "https://gw.test/g/example-api/quote");
    assert.equal(manifest.tools[0].paid, true);
    assert.equal(manifest.tools[1].paid, false);
  });

  it("rejects private upstreams at registration", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const res = await registerService(req, { baseUrl: "https://10.0.0.5" });
    assert.equal(res.status, 400);
  });
});

describe("paid proxy", () => {
  let restore;
  beforeEach(() => {
    restore = installFetchStub();
    upstreamCalls = [];
  });
  afterEach(() => restore());

  it("challenges without payment, then forwards with injected auth and a receipt", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    await registerService(req);

    const challenge = await req("/g/example-api/quote?city=YYZ");
    assert.equal(challenge.status, 402);
    const header = challenge.headers.get("PAYMENT-REQUIRED");
    assert.ok(header);
    const requirements = b64decodeJson(header);
    assert.equal(requirements.amount, "25");
    assert.equal(requirements.payTo, PAY_TO);
    assert.equal(requirements.network, "bsv:mainnet");

    const paid = await req("/g/example-api/quote?city=YYZ", {
      headers: { "PAYMENT-SIGNATURE": sigFor("paid-1", 100) },
    });
    assert.equal(paid.status, 200);
    const json = await paid.json();
    assert.equal(json.upstream, true);
    assert.match(json.url, /api\.example\.com\/v1\/quote\?city=YYZ$/);
    assert.equal(json.auth, "Bearer secret");
    assert.ok(paid.headers.get("PAYMENT-RESPONSE"));
    const receipt = b64decodeJson(paid.headers.get("PAYMENT-RESPONSE"));
    assert.equal(receipt.success, true);
    assert.ok(receipt.transaction);

    // Usage recorded with the sats attributed to the service.
    const detail = await (await req("/api/services/example-api")).json();
    assert.equal(detail.service.totals.calls, 1);
    assert.equal(detail.service.totals.sats, 25);
    assert.equal(upstreamCalls.length, 1);
  });

  it("rejects replay of the same payment txid", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    await registerService(req);
    const sig = sigFor("replay-1", 100);
    const first = await req("/g/example-api/quote", { headers: { "PAYMENT-SIGNATURE": sig } });
    assert.equal(first.status, 200);
    const second = await req("/g/example-api/quote", { headers: { "PAYMENT-SIGNATURE": sig } });
    assert.equal(second.status, 402);
    assert.equal((await second.json()).errorReason, "payment_already_used");
    assert.equal(upstreamCalls.length, 1);
  });

  it("fills {param} placeholders from query parameters and strips them", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    await registerService(req, {
      routes: [
        { name: "repos", method: "GET", path: "/users/{user}/repos", priceSats: 10, description: "Repos by user" },
      ],
    });
    const res = await req("/g/example-api/repos?user=anomalyco&page=2", {
      headers: { "PAYMENT-SIGNATURE": sigFor("tpl-1", 100) },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.url, "https://api.example.com/users/anomalyco/repos?page=2");

    const missing = await req("/g/example-api/repos", {
      headers: { "PAYMENT-SIGNATURE": sigFor("tpl-2", 100) },
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, "bad_param");

    const bad = await registerService(req, {
      name: "Bad Placeholder",
      routes: [{ name: "x", method: "GET", path: "/users/{Bad Name}", priceSats: 1, description: "x" }],
    });
    assert.equal(bad.status, 400);
  });

  it("serves free routes without payment", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    await registerService(req);
    const res = await req("/g/example-api/ping");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).upstream, true);
    assert.equal(upstreamCalls.length, 1);
  });

  it("blocks an upstream that was pointed at a private host after registration", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    await registerService(req);
    env.DB.raw
      .prepare("UPDATE xgw_services SET base_url = ? WHERE slug = 'example-api'")
      .run("https://127.0.0.1");
    const res = await req("/g/example-api/ping");
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "upstream_blocked");
    assert.equal(upstreamCalls.length, 0);
  });
});

describe("admin operations", () => {
  let restore;
  beforeEach(() => {
    restore = installFetchStub();
  });
  afterEach(() => restore());

  it("requires the admin key and supports pause/usage/rotate", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const created = await (await registerService(req)).json();
    const key = created.adminKey;

    const denied = await req("/api/services/example-api/admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    assert.equal(denied.status, 401);

    const paused = await req("/api/services/example-api/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ action: "pause" }),
    });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).service.status, "paused");

    // Paused services are invisible to the proxy and the directory.
    assert.equal((await req("/g/example-api/ping")).status, 404);
    assert.equal((await req("/api/services/example-api")).status, 404);

    const rotated = await (
      await req("/api/services/example-api/admin", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Admin-Key": key },
        body: JSON.stringify({ action: "rotate" }),
      })
    ).json();
    assert.ok(rotated.adminKey.startsWith("xgw_admin_"));
    assert.notEqual(rotated.adminKey, key);

    const staleKey = await req("/api/services/example-api/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ action: "usage" }),
    });
    assert.equal(staleKey.status, 403);
  });

  it("updates routes and prices through the admin endpoint", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const created = await (await registerService(req)).json();
    const res = await req("/api/services/example-api/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": created.adminKey },
      body: JSON.stringify({ routes: [{ name: "quote", method: "GET", path: "/v2/quote", priceSats: 50, description: "v2" }] }),
    });
    assert.equal(res.status, 200);
    const updated = (await res.json()).service;
    assert.equal(updated.routes.length, 1);
    assert.equal(updated.routes[0].priceSats, 50);

    const challenge = await req("/g/example-api/quote");
    assert.equal(challenge.status, 402);
    assert.equal(b64decodeJson(challenge.headers.get("PAYMENT-REQUIRED")).amount, "50");
  });
});
