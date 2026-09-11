import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import app from "../src/index.ts";
import { PLANS, getServicePlan, planStateFromRow, subscriptionIsActive, upsertSubscription } from "../src/plans.ts";
import { createProCheckout, handleStripeEvent, stripeEnvLivemode, productionRequiresLiveStripe } from "../src/stripe.ts";
import { HttpError } from "../src/store.ts";

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

function installFetchStub() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const isRequest = typeof input !== "string";
    const u = isRequest ? input.url : String(input);
    if (u.includes("api.github.com") || u.includes("api.example.com")) {
      return new Response(JSON.stringify({ upstream: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("arc.gorillapool")) {
      return new Response(JSON.stringify({ txid: "ab".repeat(32) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return real(input, init);
  };
  return () => {
    globalThis.fetch = real;
  };
}

function routesJson(count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `t${i}`,
    method: "GET",
    path: `/v1/t${i}`,
    priceSats: 5,
    description: `tool ${i}`,
  }));
}

async function register(req, overrides = {}) {
  return req("/api/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Tier Test",
      tagline: "Testing hosting tiers",
      description: "Tier test service",
      baseUrl: UPSTREAM,
      payTo: PAY_TO,
      ownerContact: "ops@example.com",
      routes: routesJson(2),
      ...overrides,
    }),
  });
}

function serviceId(env, slug) {
  const row = env.DB.raw.prepare("SELECT id FROM xgw_services WHERE slug = ?").get(slug);
  return row.id;
}

function subscriptionEvent(type, sub, id) {
  return { id, type, data: { object: sub } };
}

function activeSubscription(serviceId) {
  return {
    id: "sub_gw_1",
    status: "active",
    customer: "cus_gw_1",
    metadata: { serviceId },
    cancel_at_period_end: false,
    items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
  };
}

describe("plan defaults and state", () => {
  it("starts services on Free with the free limits", async () => {
    const db = makeDb();
    const plan = await getServicePlan(db, "xgw_missing");
    assert.equal(plan.id, "free");
    assert.equal(plan.limits.maxRoutes, PLANS.free.limits.maxRoutes);
    assert.equal(plan.limits.usageLog, false);
  });

  it("activates Pro only while the subscription is current", () => {
    const stale = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    assert.equal(planStateFromRow({ service_id: "s", plan: "pro", status: "active", stripe_customer_id: null, stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, created_at: "", updated_at: "" }).id, "pro");
    assert.equal(planStateFromRow({ service_id: "s", plan: "pro", status: "active", stripe_customer_id: null, stripe_subscription_id: null, current_period_end: stale, cancel_at_period_end: 0, created_at: "", updated_at: "" }).id, "free");
    assert.equal(planStateFromRow({ service_id: "s", plan: "pro", status: "canceled", stripe_customer_id: null, stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, created_at: "", updated_at: "" }).subscribedPlan, "pro");
    assert.equal(subscriptionIsActive("trialing", null), true);
    assert.equal(subscriptionIsActive("past_due", null), false);
  });

  it("fail-closes production on Stripe test keys", () => {
    assert.equal(stripeEnvLivemode({ STRIPE_SECRET_KEY: "rk_live_x" }), true);
    assert.equal(stripeEnvLivemode({ STRIPE_SECRET_KEY: "rk_test_x" }), false);
    assert.equal(productionRequiresLiveStripe("entangleit.com", false), true);
    assert.equal(productionRequiresLiveStripe("entangleit.com", true), false);
    assert.equal(productionRequiresLiveStripe("localhost", false), false);
  });
});

describe("tier enforcement", () => {
  let restore;
  beforeEach(() => {
    restore = installFetchStub();
  });
  afterEach(() => restore());

  it("limits free registration to 5 routes with an upgrade hint", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const ok = await register(req, { routes: routesJson(5) });
    assert.equal(ok.status, 201);
    const over = await register(req, { name: "Too Big", routes: routesJson(6) });
    assert.equal(over.status, 402);
    const body = await over.json();
    assert.equal(body.code, "plan_limit");
    assert.equal(body.plan, "free");
    assert.equal(body.priceCents, 900);
    assert.match(String(body.upgrade), /\/x402gateway\//);
  });

  it("gate analytics behind Pro and let Pro update up to 100 routes", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const created = await (await register(req)).json();
    const key = created.adminKey;
    const id = serviceId(env, "tier-test");

    // Free: usage log and CSV export are gated.
    const usage = await req("/api/services/tier-test/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ action: "usage" }),
    });
    assert.equal(usage.status, 402);
    assert.equal((await usage.json()).code, "plan_limit");

    const csvFree = await req("/api/services/tier-test/usage.csv", { headers: { "X-Admin-Key": key } });
    assert.equal(csvFree.status, 402);

    // Upgrade this service to Pro.
    await upsertSubscription(env.DB, {
      serviceId: id,
      plan: "pro",
      status: "active",
      stripeCustomerId: "cus_gw_1",
      stripeSubscriptionId: "sub_gw_1",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });

    const plan = await (await req("/api/services/tier-test/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ action: "plan" }),
    })).json();
    assert.equal(plan.plan.id, "pro");
    assert.equal(plan.plan.limits.maxRoutes, 100);

    // 60 routes now fit, and the usage CSV works.
    const big = await req("/api/services/tier-test/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ routes: routesJson(60) }),
    });
    assert.equal(big.status, 200);
    assert.equal((await big.json()).service.routes.length, 60);

    const csv = await req("/api/services/tier-test/usage.csv", { headers: { "X-Admin-Key": key } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(await csv.text(), /created_at,route,payer,sats,txid,status,ms/);
  });

  it("rejects checkout when Stripe is not configured", async () => {
    const env = testEnv(makeDb());
    const req = makeCall(env);
    const created = await (await register(req)).json();
    const res = await req("/api/services/tier-test/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": created.adminKey },
      body: JSON.stringify({ action: "checkout" }),
    });
    assert.equal(res.status, 503);
  });

  it("refuses to create a checkout with test keys on production hosts", async () => {
    const env = testEnv(makeDb(), { STRIPE_SECRET_KEY: "rk_test_abc" });
    const err = await createProCheckout(env, { id: "xgw_1", slug: "s", name: "S", owner_contact: "" }, "https://entangleit.com/x402gateway").catch((e) => e);
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 503);
  });
});

describe("stripe subscription webhooks", () => {
  let restore;
  beforeEach(() => {
    restore = installFetchStub();
  });
  afterEach(() => restore());

  async function makePro(db) {
    const env = testEnv(db);
    const req = makeCall(env);
    const created = await (await register(req)).json();
    return { env, req, key: created.adminKey, id: serviceId(env, "tier-test") };
  }

  it("activates Pro from customer.subscription.updated and is idempotent", async () => {
    const db = makeDb();
    const { env, id } = await makePro(db);
    const event = subscriptionEvent("customer.subscription.updated", activeSubscription(id), "evt_gw_1");
    await handleStripeEvent(env, event);
    let plan = await getServicePlan(db, id, env);
    assert.equal(plan.id, "pro");
    assert.equal(plan.active, true);
    assert.equal(plan.currentPeriodEnd !== null, true);

    db.raw.prepare("UPDATE xgw_subscriptions SET status = 'canceled' WHERE service_id = ?").run(id);
    await handleStripeEvent(env, event);
    plan = await getServicePlan(db, id, env);
    assert.equal(plan.status, "canceled");
  });

  it("handles deletion and invoice failures", async () => {
    const db = makeDb();
    const { env, id } = await makePro(db);
    await handleStripeEvent(env, subscriptionEvent("customer.subscription.updated", activeSubscription(id), "evt_gw_a"));
    await handleStripeEvent(
      env,
      subscriptionEvent("customer.subscription.deleted", { ...activeSubscription(id), status: "canceled" }, "evt_gw_b"),
    );
    assert.equal((await getServicePlan(db, id, env)).id, "free");

    await handleStripeEvent(env, subscriptionEvent("customer.subscription.updated", activeSubscription(id), "evt_gw_c"));
    await handleStripeEvent(
      env,
      { id: "evt_gw_d", type: "invoice.payment_failed", data: { object: { customer: "cus_gw_1" } } },
    );
    const plan = await getServicePlan(db, id, env);
    assert.equal(plan.status, "past_due");
    // Dunning grace: past_due keeps Pro until the period ends.
    assert.equal(plan.id, "pro");
    assert.equal(plan.active, true);

    db.raw.prepare("UPDATE xgw_subscriptions SET current_period_end = ? WHERE service_id = ?").run(
      new Date(Date.now() - 3600 * 1000).toISOString(), id);
    const lapsed = await getServicePlan(db, id, env);
    assert.equal(lapsed.status, "past_due");
    assert.equal(lapsed.id, "free");
    assert.equal(lapsed.active, false);
  });

  it("creates a minimal row from checkout.session.completed", async () => {
    const db = makeDb();
    const { env, id } = await makePro(db);
    await handleStripeEvent(env, {
      id: "evt_gw_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_gw_1",
          mode: "subscription",
          payment_status: "paid",
          customer: "cus_gw_2",
          subscription: "sub_gw_2",
          metadata: { serviceId: id },
        },
      },
    });
    const plan = await getServicePlan(db, id, env);
    assert.equal(plan.active, true);
    assert.equal(plan.status, "active");
    const row = db.raw.prepare("SELECT stripe_subscription_id FROM xgw_subscriptions WHERE service_id = ?").get(id);
    assert.equal(row.stripe_subscription_id, "sub_gw_2");
  });
});


describe("analytics dashboard", () => {
  let restore;
  beforeEach(() => {
    restore = installFetchStub();
  });
  afterEach(() => restore());

  async function setup() {
    const db = makeDb();
    const env = testEnv(db);
    const req = makeCall(env);
    const created = await (await register(req)).json();
    const id = serviceId(env, "tier-test");
    const insert = db.raw.prepare(
      "INSERT INTO xgw_usage (id, service_id, route, payer, sats, txid, status, ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const now = new Date().toISOString();
    insert.run("u1", id, "t0", "bsv:input:aaa", 5, "aa".repeat(32), 200, 120, now);
    insert.run("u2", id, "t0", "bsv:input:bbb", 5, "bb".repeat(32), 200, 80, now);
    insert.run("u3", id, "t1", "bsv:input:ccc", 0, "", 502, 900, now);
    return { db, env, req, id, key: created.adminKey };
  }

  async function makePro(db, id) {
    await upsertSubscription(db, {
      serviceId: id,
      plan: "pro",
      status: "active",
      stripeCustomerId: "cus_gw_1",
      stripeSubscriptionId: "sub_gw_1",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });
  }

  it("gives free services aggregates only and gates share links", async () => {
    const { req, key } = await setup();
    const res = await req("/api/services/tier-test/analytics?days=30", { headers: { "X-Admin-Key": key } });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.pro, false);
    assert.deepEqual(d.totals, { calls: 3, sats: 10, paidCalls: 2, freeCalls: 1, errors: 1, successRate: 66.7 });
    assert.deepEqual(d.byRoute, []);
    assert.deepEqual(d.recent, []);

    const share = await req("/api/services/tier-test/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ action: "share" }),
    });
    assert.equal(share.status, 402);
    assert.equal((await share.json()).code, "plan_limit");
  });

  it("serves Pro analytics to the owner and through a public share token", async () => {
    const { db, env, req, id, key } = await setup();
    await makePro(db, id);

    const owner = await (await req("/api/services/tier-test/analytics", { headers: { "X-Admin-Key": key } })).json();
    assert.equal(owner.pro, true);
    assert.equal(owner.byRoute.length, 2);
    assert.equal(owner.byRoute[0].route, "t0");
    assert.equal(owner.byRoute[0].calls, 2);
    assert.equal(owner.recent.length, 3);
    assert.ok(owner.byDay.length >= 1);

    const created = await (await req("/api/services/tier-test/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ action: "share" }),
    })).json();
    assert.match(created.url, /\/dashboard\?token=xgw_dash_/);

    const token = created.token;
    const pub = await req(`/api/dashboards/${token}/analytics?days=30`);
    assert.equal(pub.status, 200);
    const pubData = await pub.json();
    assert.equal(pubData.service.slug, "tier-test");
    assert.equal(pubData.totals.calls, 3);
    assert.equal(pubData.recent.length, 3);

    const shared = await (await req("/api/services/tier-test/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ action: "shared" }),
    })).json();
    assert.equal(shared.active, true);
    assert.ok(shared.views >= 1); // the public view ticked the counter

    // Rotate invalidates the old token; unshare revokes the new one.
    const rotated = await (await req("/api/services/tier-test/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ action: "share" }),
    })).json();
    assert.notEqual(rotated.token, token);
    assert.equal((await req(`/api/dashboards/${token}/analytics`)).status, 404);

    await req("/api/services/tier-test/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify({ action: "unshare" }),
    });
    assert.equal((await req(`/api/dashboards/${rotated.token}/analytics`)).status, 404);
  });

  it("requires the admin key and 404s unknown tokens", async () => {
    const { req } = await setup();
    assert.equal((await req("/api/services/tier-test/analytics")).status, 401);
    assert.equal((await req("/api/services/tier-test/analytics", { headers: { "X-Admin-Key": "wrong" } })).status, 403);
    assert.equal((await req("/api/dashboards/xgw_dash_nope/analytics")).status, 404);
  });
});
