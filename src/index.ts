/**
 * x402 Gateway — register any upstream API with a price and get a hosted,
 * pay-per-call x402 endpoint. Buyers (agents, humans) pay in BSV sats; the
 * gateway verifies and broadcasts the payment, then proxies the upstream call
 * with the seller's credentials injected. No keys are held for buyers.
 *
 * Routes:
 *   GET  /                          registration + directory UI
 *   GET  /health
 *   GET  /api/services[?q=]         list active gateway services
 *   GET  /api/services/:slug        service detail (no secrets)
 *   POST /api/services              register {name, baseUrl, payTo, routes[]}
 *   POST /api/services/:slug/admin  owner ops (X-Admin-Key)
 *   GET  /g/:slug/manifest          registry manifest (x402market-ready)
 *   ALL  /g/:slug/:tool             paid proxy endpoint
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { DOCS_HTML } from "./docsPage.generated.ts";
import {
  arcBroadcast,
  b64decodeJson,
  b64encodeJson,
  buildRequirements,
  claimPaymentTxid,
  verifyBsvPayment,
  BSV_NETWORK,
  type BsvPaymentPayload,
  type Env,
} from "./x402.ts";
import {
  HttpError,
  cleanStr,
  createService,
  db,
  deleteService,
  getServiceBySlug,
  isPrivateHost,
  listServices,
  listUsage,
  mintAdminKey,
  nowIso,
  parseBaseUrl,
  publicService,
  recordUsage,
  requireAdmin,
  routesOf,
  sha256Hex,
  getDashboard,
  getServiceById,
  resolveDashboardToken,
  revokeDashboardToken,
  rotateDashboardToken,
  touchDashboard,
  updateService,
  upsertRegistryListing,
  validateServiceInput,
  type GatewayRoute,
  type ServiceRow,
} from "./store.ts";
import { PLANS, PLAN_LIMIT_CODE, getServicePlan, planStateFromRow, type PlanState } from "./plans.ts";
import { buildAnalytics, clampDays } from "./analytics.ts";
import { dashboardHtml } from "./dashboard.ts";
import {
  createBillingPortal,
  createProCheckout,
  handleStripeEvent,
  stripeClient,
  stripeConfigured,
} from "./stripe.ts";

const api = new Hono<{ Bindings: Env }>({ strict: false });

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, PAYMENT-SIGNATURE",
  "Access-Control-Max-Age": "86400",
};

const asJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function num(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function publicBase(env: Env): string {
  return (env.PUBLIC_BASE || "https://entangleit.com/x402gateway").replace(/\/$/, "");
}

function planLimitError(env: Env, message: string, plan: PlanState): HttpError {
  return new HttpError(402, message, {
    code: PLAN_LIMIT_CODE,
    plan: plan.id,
    priceCents: plan.priceCents,
    upgrade: `${publicBase(env)}/?upgrade=1`,
  });
}

function publicPlan(plan: PlanState) {
  return {
    id: plan.id,
    name: PLANS[plan.id].name,
    subscribedPlan: plan.subscribedPlan,
    active: plan.active,
    status: plan.status,
    currentPeriodEnd: plan.currentPeriodEnd,
    cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
    priceCents: plan.priceCents,
    limits: plan.limits,
  };
}

function ipOf(c: Context<{ Bindings: Env }>): string {
  const fwd = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
  return c.req.header("CF-Connecting-IP") ?? fwd ?? "anon";
}

interface MeterKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/** Fixed-window KV limiter; open when KV is unbound. */
async function allowRate(env: Env, key: string, limit: number, ttlSeconds: number): Promise<boolean> {
  const kv = env.METER as MeterKV | undefined;
  if (!kv || limit <= 0) return true;
  try {
    const current = Number.parseInt((await kv.get(key)) ?? "0", 10) || 0;
    if (current >= limit) return false;
    await kv.put(key, String(current + 1), { expirationTtl: ttlSeconds });
    return true;
  } catch {
    return true;
  }
}

api.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  await next();
  for (const [k, v] of Object.entries(CORS_HEADERS)) c.res.headers.set(k, v);
});

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, ...(err.payload ?? {}) }, err.status as 400);
  console.error("[x402-gateway]", err);
  return c.json({ error: "Internal error" }, 500);
});

// ---------- public API ----------

api.get("/health", async (c) => {
  const services = await listServices(db(c.env), 1000);
  return c.json({
    ok: true,
    service: "x402-gateway",
    network: BSV_NETWORK,
    services: services.length,
    base: publicBase(c.env),
  });
});

api.get("/api/services", async (c) => {
  const q = (c.req.query("q") ?? "").toLowerCase();
  const base = publicBase(c.env);
  const rows = await listServices(db(c.env), 200);
  const services = rows
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.tagline.toLowerCase().includes(q) || r.slug.includes(q))
    .map((r) => publicService(r, `${base}/g`));
  return asJson({ services, count: services.length });
});

api.get("/api/services/:slug", async (c) => {
  const row = await getServiceBySlug(db(c.env), c.req.param("slug"));
  if (!row || row.status !== "active") return asJson({ error: "service_not_found" }, 404);
  const plan = await getServicePlan(db(c.env), row.id, c.env);
  return asJson({ service: publicService(row, `${publicBase(c.env)}/g`, publicPlan(plan)) });
});

/** Register a service: returns the admin key once and auto-lists in x402market. */
api.post("/api/services", async (c) => {
  const ip = ipOf(c);
  const allowed = await allowRate(
    c.env,
    `xgw:reg:${ip}:${nowIso().slice(0, 10)}`,
    num(c.env, "MAX_SERVICES_PER_IP_PER_DAY", 5),
    86400,
  );
  if (!allowed) throw new HttpError(429, "Too many registrations from this IP today");

  const text = await c.req.text();
  if (text.length > 32_768) throw new HttpError(413, "registration body too large");
  let raw: unknown = {};
  try {
    raw = JSON.parse(text || "{}");
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }

  // New services are Free; over-cap route lists get an upgrade hint.
  const freePlan = planStateFromRow(null, c.env);
  const rawRoutes = (raw as { routes?: unknown }).routes;
  if (Array.isArray(rawRoutes) && rawRoutes.length > freePlan.limits.maxRoutes) {
    throw planLimitError(
      c.env,
      `Free plan allows ${freePlan.limits.maxRoutes} routes per service — upgrade to Pro for ${PLANS.pro.limits.maxRoutes} plus per-call analytics.`,
      freePlan,
    );
  }
  const input = validateServiceInput(raw, freePlan.limits.maxRoutes);
  const adminKey = mintAdminKey();
  const slugBase = input.name;
  // uniqueSlug needs the db; it is defined in store with the same helper name.
  const { uniqueSlug } = await import("./store.ts");
  const slug = await uniqueSlug(db(c.env), slugBase);
  const row = await createService(db(c.env), input, await sha256Hex(adminKey), slug);

  // Auto-list in the x402market registry. Failures are reported but do not
  // block registration (the owner can relist from the admin endpoint).
  // Listing runs after the response: the registry verifies by fetching this
  // worker's manifest, which it cannot do while this request is awaiting it.
  // List in x402market. The gateway and the registry share the same D1 and
  // operator, so the gateway writes its verified listing directly (it is the
  // source of truth for its own routes and payTo). The manifest URL stays on
  // workers.dev so the registry's recheck can fetch it from outside the zone.
  const workersDev = (c.env.WORKERS_DEV_BASE || new URL(c.req.url).origin).replace(/\/$/, "");
  const manifestUrl = `${workersDev}/g/${slug}/manifest`;
  const registryId = await upsertRegistryListing(db(c.env), row, {
    manifestUrl,
    baseUrl: publicBase(c.env),
    toolBase: workersDev,
  });
  await updateService(db(c.env), row, { registry_id: registryId });
  const listing = { ok: true as const, serviceId: registryId };

  const base = publicBase(c.env);
  return asJson(
    {
      service: publicService(row, `${base}/g`),
      adminKey,
      gatewayBase: `${base}/g/${slug}`,
      dashboard: `${base}/dashboard?service=${slug}`,
      listing,
      note: "Store the admin key now — it is shown only once. Paid routes are live immediately; the registry listing verifies within seconds.",
    },
    201,
  );
});

/** Owner operations. Send the admin key in X-Admin-Key. */
api.post("/api/services/:slug/admin", async (c) => {
  const slug = c.req.param("slug");
  const adminKey = c.req.header("X-Admin-Key") ?? "";
  if (!adminKey) throw new HttpError(401, "X-Admin-Key header is required");
  const row = await requireAdmin(db(c.env), slug, adminKey);
  const text = await c.req.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text || "{}") as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  const action = cleanStr(body.action, 30);

  switch (action) {
    case "plan": {
      const plan = await getServicePlan(db(c.env), row.id, c.env);
      return asJson({ plan: publicPlan(plan) });
    }
    case "checkout": {
      const plan = await getServicePlan(db(c.env), row.id, c.env);
      if (plan.active) throw new HttpError(409, "This service is already on Pro — manage it in the billing portal");
      const checkout = await createProCheckout(c.env, row, publicBase(c.env));
      return asJson({
        ...checkout,
        plan: publicPlan(plan),
        note: "Open this Stripe Checkout URL in a browser to subscribe. Pro activates when the Stripe webhook confirms payment.",
      });
    }
    case "portal": {
      const session = await createBillingPortal(c.env, row, publicBase(c.env));
      return asJson({ ...session, note: "Stripe-hosted portal: update payment method, cancel, or download invoices." });
    }
    case "share": {
      const plan = await getServicePlan(db(c.env), row.id, c.env);
      if (!plan.limits.usageLog) {
        throw planLimitError(c.env, "Public analytics links are a Pro feature — upgrade to share the dashboard.", plan);
      }
      const dash = await rotateDashboardToken(db(c.env), row.id);
      return asJson({
        url: `${publicBase(c.env)}/dashboard?token=${dash.token}`,
        token: dash.token,
        views: 0,
        createdAt: dash.created_at,
        note: "Anyone with this link can view analytics read-only. Rotate or revoke it any time.",
      });
    }
    case "shared": {
      const dash = await getDashboard(db(c.env), row.id);
      if (!dash || dash.revoked === 1) return asJson({ active: false });
      return asJson({
        active: true,
        url: `${publicBase(c.env)}/dashboard?token=${dash.token}`,
        views: dash.views,
        lastViewedAt: dash.last_viewed_at,
        createdAt: dash.created_at,
      });
    }
    case "unshare": {
      const revoked = await revokeDashboardToken(db(c.env), row.id);
      return asJson({ revoked });
    }
    case "usage": {
      const plan = await getServicePlan(db(c.env), row.id, c.env);
      if (!plan.limits.usageLog) {
        throw planLimitError(c.env, "Per-call analytics are a Pro feature — upgrade to see the call log.", plan);
      }
      const usage = await listUsage(db(c.env), row.id, Number(body.limit) || 25);
      return asJson({ service: publicService(row, `${publicBase(c.env)}/g`, publicPlan(plan)), usage });
    }
    case "pause":
    case "resume": {
      const updated = await updateService(db(c.env), row, { status: action === "pause" ? "paused" : "active" });
      return asJson({ service: publicService(updated, `${publicBase(c.env)}/g`) });
    }
    case "delete": {
      await deleteService(db(c.env), row.id);
      return asJson({ deleted: true });
    }
    case "rotate": {
      const fresh = mintAdminKey();
      await db(c.env)
        .prepare("UPDATE xgw_services SET admin_key_hash = ?, updated_at = ? WHERE id = ?")
        .bind(await sha256Hex(fresh), nowIso(), row.id)
        .run();
      return asJson({ adminKey: fresh, note: "New admin key issued — the previous one is invalid immediately." });
    }
    case "relist": {
      // Background re-list for the same reason as registration.
      const workersDev = (c.env.WORKERS_DEV_BASE || new URL(c.req.url).origin).replace(/\/$/, "");
      const manifestUrl = `${workersDev}/g/${row.slug}/manifest`;
      const registryId = await upsertRegistryListing(db(c.env), row, {
        manifestUrl,
        baseUrl: publicBase(c.env),
        toolBase: workersDev,
      });
      const updated = await updateService(db(c.env), row, { registry_id: registryId });
      return asJson({
        listed: true,
        registryId,
        service: publicService(updated, `${publicBase(c.env)}/g`),
        note: "Listing refreshed — the directory updates immediately.",
      });
    }
    default: {
      // Update fields.
      const plan = await getServicePlan(db(c.env), row.id, c.env);
      const maxRoutes = plan.limits.maxRoutes;
      if (Array.isArray(body.routes) && body.routes.length > maxRoutes) {
        throw planLimitError(
          c.env,
          `This service's ${plan.id} plan allows ${maxRoutes} routes — upgrade to Pro for ${PLANS.pro.limits.maxRoutes}.`,
          plan,
        );
      }
      const patch: Parameters<typeof updateService>[2] = {};
      if (body.name !== undefined) patch.name = cleanStr(body.name, 60);
      if (body.tagline !== undefined) patch.tagline = cleanStr(body.tagline, 120);
      if (body.description !== undefined) patch.description = cleanStr(body.description, 2000);
      if (body.ownerContact !== undefined) patch.owner_contact = cleanStr(body.ownerContact, 160);
      if (body.baseUrl !== undefined) patch.base_url = parseBaseUrl(body.baseUrl);
      if (body.payTo !== undefined) {
        const validated = validateServiceInput({ ...serviceToInput(row), payTo: body.payTo, routes: routesOf(row) }, maxRoutes);
        patch.pay_to = validated.payTo;
      }
      if (body.authHeader !== undefined || body.authValue !== undefined) {
        const validated = validateServiceInput(
          {
            ...serviceToInput(row),
            authHeader: body.authHeader ?? row.auth_header,
            authValue: body.authValue ?? row.auth_value,
            routes: routesOf(row),
          },
          maxRoutes,
        );
        patch.auth_header = validated.authHeader;
        patch.auth_value = validated.authValue;
      }
      if (body.routes !== undefined) {
        const validated = validateServiceInput({ ...serviceToInput(row), routes: body.routes }, maxRoutes);
        patch.routes_json = JSON.stringify(validated.routes);
      }
      if (Object.keys(patch).length === 0) throw new HttpError(400, "no supported fields or action provided");
      const updated = await updateService(db(c.env), row, patch);
      return asJson({ service: publicService(updated, `${publicBase(c.env)}/g`) });
    }
  }
});

function serviceToInput(row: ServiceRow) {
  return {
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    baseUrl: row.base_url,
    payTo: row.pay_to,
    ownerContact: row.owner_contact,
    authHeader: row.auth_header,
    authValue: row.auth_value,
    routes: routesOf(row),
  };
}

/** Pro-only CSV of per-call analytics. */
api.get("/api/services/:slug/usage.csv", async (c) => {
  const adminKey = c.req.header("X-Admin-Key") ?? "";
  if (!adminKey) throw new HttpError(401, "X-Admin-Key header is required");
  const row = await requireAdmin(db(c.env), c.req.param("slug"), adminKey);
  const plan = await getServicePlan(db(c.env), row.id, c.env);
  if (!plan.limits.usageLog) {
    throw planLimitError(c.env, "CSV export is a Pro feature — upgrade to export call history.", plan);
  }
  const usage = await listUsage(db(c.env), row.id, 1000);
  const esc = (v: unknown) => {
    const str = String(v ?? "");
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const rows = [
    ["created_at", "route", "payer", "sats", "txid", "status", "ms"],
    ...usage.map((u) => [u.created_at, u.route, u.payer, u.sats, u.txid, u.status, u.ms]),
  ];
  const csv = `${rows.map((r) => r.map(esc).join(",")).join("\r\n")}\r\n`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="x402gateway-${row.slug}.csv"`,
    },
  });
});

/** Owner analytics (admin key). */
api.get("/api/services/:slug/analytics", async (c) => {
  const adminKey = c.req.header("X-Admin-Key") ?? "";
  if (!adminKey) throw new HttpError(401, "X-Admin-Key header is required");
  const row = await requireAdmin(db(c.env), c.req.param("slug"), adminKey);
  const plan = await getServicePlan(db(c.env), row.id, c.env);
  return asJson(await buildAnalytics(db(c.env), row, plan, clampDays(c.req.query("days"))));
});

/** Public analytics via a share token (read-only, revocable). */
api.get("/api/dashboards/:token/analytics", async (c) => {
  const token = c.req.param("token");
  const serviceId = await resolveDashboardToken(db(c.env), token);
  if (!serviceId) return asJson({ error: "dashboard_not_found" }, 404);
  const row = await getServiceById(db(c.env), serviceId);
  if (!row || row.status !== "active") return asJson({ error: "service_not_found" }, 404);
  c.executionCtx.waitUntil(touchDashboard(db(c.env), token));
  const plan = await getServicePlan(db(c.env), row.id, c.env);
  return asJson(await buildAnalytics(db(c.env), row, plan, clampDays(c.req.query("days"))));
});

/** Analytics dashboard page (owner key or public token). */
api.get("/dashboard", (c) => c.html(dashboardHtml(publicBase(c.env))));

/** Stripe webhook: flips services to/from Pro. Signature-verified + deduped. */
api.post("/webhooks/stripe", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !stripeConfigured(c.env)) throw new HttpError(503, "Stripe is not configured");
  const signature = c.req.header("stripe-signature");
  if (!signature) throw new HttpError(400, "Missing stripe-signature");
  const payload = await c.req.text();
  const stripe = stripeClient(c.env);
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, secret);
  } catch (err) {
    throw new HttpError(400, `Webhook signature failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
  c.executionCtx.waitUntil(handleStripeEvent(c.env, event));
  return c.json({ received: true });
});

// ---------- manifest + proxy ----------

function manifestFor(env: Env, row: ServiceRow, origin: string) {
  const routes = routesOf(row);
  return {
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    baseUrl: origin,
    network: BSV_NETWORK,
    x402: { x402Version: 2, scheme: "exact", network: BSV_NETWORK, asset: "native:BSV", payTo: row.pay_to },
    tools: routes.map((r) => ({
      name: r.name,
      method: r.method,
      path: `${origin}/g/${row.slug}/${r.name}`,
      priceSats: r.priceSats,
      paid: r.priceSats > 0,
      description: r.description,
    })),
  };
}

api.get("/g/:slug/manifest", async (c) => {
  const row = await getServiceBySlug(db(c.env), c.req.param("slug"));
  if (!row || row.status !== "active") return asJson({ error: "service_not_found" }, 404);
  const origin = new URL(c.req.url).origin;
  return asJson(manifestFor(c.env, row, origin));
});

const ALLOWED_FORWARD_HEADERS = new Set(["accept", "accept-language", "content-type"]);

/** Proxy one gateway route: challenge, settle, forward upstream, return. */
async function proxyRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const started = Date.now();
  const slug = c.req.param("slug") ?? "";
  const tool = c.req.param("tool") ?? "";
  const row = await getServiceBySlug(db(c.env), slug);
  if (!row || row.status !== "active") return asJson({ error: "service_not_found" }, 404);
  const route = routesOf(row).find((r) => r.name === tool);
  if (!route) return asJson({ error: "tool_not_found" }, 404);

  const publicUrl = `${publicBase(c.env)}/g/${row.slug}/${route.name}`;
  const ip = ipOf(c);
  const limit = num(c.env, "RATE_LIMIT_PER_MIN", 60);
  if (!(await allowRate(c.env, `xgw:rl:${ip}:${row.slug}:${new Date().toISOString().slice(0, 16)}`, limit, 120))) {
    return asJson({ error: "rate_limited", retryAfterSec: 60 }, 429, { "Retry-After": "60" });
  }

  const price = route.priceSats;
  const signature = c.req.header("PAYMENT-SIGNATURE");

  let paidAmount = 0;
  let payer = "";
  let txid = "";
  if (price > 0) {
    const requirements = buildRequirements({
      url: publicUrl,
      description: `${row.name}/${route.name}: ${route.description || "paid call"}`,
      satoshis: price,
      payTo: row.pay_to,
      arcUrl: c.env.ARC_URL || "https://arc.gorillapool.io/v1",
    });
    if (!signature) {
      return asJson(
        { error: "payment_required", priceSats: price, payTo: row.pay_to, network: BSV_NETWORK, resource: publicUrl },
        402,
        { "PAYMENT-REQUIRED": b64encodeJson(requirements) },
      );
    }
    let payload: BsvPaymentPayload;
    try {
      payload = b64decodeJson<BsvPaymentPayload>(signature);
    } catch {
      return asJson({ success: false, errorReason: "invalid_payload", network: BSV_NETWORK }, 402);
    }
    const verified = await verifyBsvPayment(requirements, payload);
    if (!verified.success) return asJson({ ...verified, network: BSV_NETWORK }, 402);
    let receiptTxid = verified.txid;
    try {
      const broadcast = await arcBroadcast(c.env, verified.txHex);
      receiptTxid = broadcast.txid || verified.txid;
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      if (status !== undefined && !(status >= 500 && status <= 599) && !/timeout|abort|network/i.test(msg)) {
        return asJson({ success: false, errorReason: "invalid_transaction_state", detail: msg }, 402);
      }
      // pending-but-served
    }
    // Replay guard keys on the deterministic txid from the tx bytes, so two
    // broadcasts of the same tx can never pay for two calls.
    if (!(await claimPaymentTxid(c.env, verified.txid))) {
      return asJson({ success: false, errorReason: "payment_already_used", network: BSV_NETWORK }, 402);
    }
    paidAmount = price;
    payer = verified.payer;
    txid = receiptTxid;
  }

  // Forward upstream with the seller's credentials; never the caller's.
  // `{param}` placeholders in the route path are filled from query parameters
  // and stripped from the forwarded query to avoid duplicates.
  const callerQuery = new URL(c.req.url).searchParams;
  const consumed = new Set<string>();
  let upstreamPath: string;
  try {
    upstreamPath = route.path.replace(/\{([a-z0-9_]{1,30})\}/g, (_match, name: string) => {
      const value = (callerQuery.get(name) ?? "").trim();
      if (!value || value.length > 200) {
        throw new HttpError(400, `missing or invalid path parameter "${name}"`);
      }
      consumed.add(name);
      return encodeURIComponent(value);
    });
  } catch (e) {
    if (e instanceof HttpError) return asJson({ error: e.message, code: "bad_param" }, e.status as 400);
    throw e;
  }
  const upstreamUrl = new URL(row.base_url + upstreamPath);
  if (isPrivateHost(upstreamUrl)) {
    return asJson({ error: "upstream_blocked", detail: "upstream resolves to a private or local host" }, 502);
  }
  if (c.req.method === "GET") {
    for (const [k, v] of callerQuery) if (!consumed.has(k)) upstreamUrl.searchParams.append(k, v);
  }
  const headers = new Headers({ "user-agent": "x402-gateway/1 (+https://entangleit.com/x402gateway)" });
  for (const name of ALLOWED_FORWARD_HEADERS) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  if (row.auth_header) headers.set(row.auth_header, row.auth_value);

  let requestBody: string | undefined;
  if (c.req.method === "POST") {
    requestBody = await c.req.text();
    if (requestBody.length > num(c.env, "MAX_REQUEST_BYTES", 65_536)) {
      return asJson({ error: "request_too_large", maxBytes: num(c.env, "MAX_REQUEST_BYTES", 65_536) }, 413);
    }
    if (!headers.get("content-type")) headers.set("content-type", "application/json");
  }

  const maxBytes = num(c.env, "MAX_RESPONSE_BYTES", 524_288);
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method: c.req.method,
      headers,
      body: requestBody,
      // Never follow redirects: a 3xx could point at a private host.
      redirect: "manual",
      signal: AbortSignal.timeout(num(c.env, "UPSTREAM_TIMEOUT_MS", 20_000)),
    });
  } catch (e) {
    const detail = String((e as Error)?.message ?? e).slice(0, 200);
    c.executionCtx.waitUntil(
      recordUsage(db(c.env), { serviceId: row.id, route: route.name, payer, sats: paidAmount, txid, status: 502, ms: Date.now() - started }),
    );
    return asJson({ error: "upstream_failed", detail, charged: paidAmount > 0 }, 502);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    c.executionCtx.waitUntil(
      recordUsage(db(c.env), { serviceId: row.id, route: route.name, payer, sats: paidAmount, txid, status: 502, ms: Date.now() - started }),
    );
    return asJson({ error: "upstream_redirect_blocked", status: upstream.status, charged: paidAmount > 0 }, 502);
  }

  const buffer = new Uint8Array(await upstream.arrayBuffer());
  const truncated = buffer.length > maxBytes;
  const body = truncated ? buffer.slice(0, maxBytes) : buffer;

  c.executionCtx.waitUntil(
    recordUsage(db(c.env), {
      serviceId: row.id,
      route: route.name,
      payer,
      sats: paidAmount,
      txid,
      status: upstream.status,
      ms: Date.now() - started,
    }),
  );

  const responseHeaders: Record<string, string> = {
    "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
    ...(truncated ? { "X-Gateway-Truncated": "1" } : {}),
  };
  if (price > 0) {
    responseHeaders["PAYMENT-RESPONSE"] = b64encodeJson({
      success: true,
      payer,
      transaction: txid,
      network: BSV_NETWORK,
    });
  }
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}

api.on(["GET", "POST"], "/g/:slug/:tool", proxyRoute);

// ---------- UI ----------

api.get("/", (c) => {
  const base = publicBase(c.env);
  return c.html(landingHtml(base));
});

// Static documentation (generated from portfolio content/x402gateway/docs.md
// by portfolio/scripts/sync-worker-docs.mjs). Cacheable HTML, no secrets.
api.get("/docs", (c) => {
  return c.html(DOCS_HTML, 200, {
    "cache-control": "public, max-age=3600",
  });
});
function landingHtml(base: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>x402 Gateway — turn any API into a paid endpoint for AI agents</title>
<meta name="description" content="Register an upstream API, set sat prices per route, and get a hosted x402 endpoint with auth injection, replay protection, and analytics. Free tier, Pro at $9/mo.">
<link rel="canonical" href="https://entangleit.com/x402gateway/">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="x402 Gateway">
<meta property="og:url" content="https://entangleit.com/x402gateway/">
<meta property="og:title" content="x402 Gateway — turn any API into a paid endpoint for AI agents">
<meta property="og:description" content="Hosted x402 endpoints with auth injection, replay protection, and analytics. Agents pay per call in sats. Free tier, Pro $9/mo.">
<meta property="og:image" content="https://entangleit.com/og/x402gateway.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="x402 Gateway — turn any API into a paid endpoint for AI agents">
<meta name="twitter:description" content="Hosted x402 endpoints with auth injection, replay protection, and analytics. Agents pay per call in sats.">
<meta name="twitter:image" content="https://entangleit.com/og/x402gateway.png">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"SoftwareApplication","name":"x402 Gateway","url":"https://entangleit.com/x402gateway/","description":"A hosted gateway that turns any upstream API into a pay-per-call x402 endpoint with auth injection, replay protection, and analytics.","applicationCategory":"DeveloperApplication","operatingSystem":"Web","publisher":{"@type":"Organization","name":"EntangleIT","url":"https://entangleit.com/"}}
</script>
<style>
  :root { --bg:#0b0e14; --panel:#121722; --line:#232c3d; --text:#e8edf5; --muted:#8b97ab; --accent:#6ee7b7; --accent2:#38bdf8; }
  * { box-sizing:border-box; }
  body { margin:0; background:radial-gradient(1200px 600px at 20% -10%, #16233a 0%, var(--bg) 55%); color:var(--text); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:960px; margin:0 auto; padding:36px 20px 70px; }
  h1 { font-size:30px; margin:0 0 6px; letter-spacing:-.5px; }
  h2 { font-size:18px; margin:34px 0 10px; }
  p { color:var(--muted); }
  a { color:var(--accent2); text-decoration:none; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:20px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  label { display:block; font-size:12px; color:var(--muted); margin:10px 0 4px; text-transform:uppercase; letter-spacing:.05em; }
  input, textarea { width:100%; background:#0d1320; border:1px solid var(--line); border-radius:8px; color:var(--text); padding:10px 12px; font:inherit; }
  textarea { min-height:150px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  button { margin-top:14px; background:var(--accent); color:#08130f; border:0; border-radius:8px; padding:11px 18px; font-weight:700; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .ghostBtn { background:transparent; color:var(--accent); border:1px solid var(--accent); margin-top:0; padding:6px 12px; font-weight:600; }
  code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre { background:#0d1320; border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; font-size:12.5px; }
  .result { margin-top:16px; display:none; }
  .ok { color:var(--accent); font-weight:600; }
  .err { color:#f87171; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:1px 8px; font-size:11px; color:var(--muted); }
  @media (max-width:700px){ .grid { grid-template-columns:1fr; } }
</style></head>
<body><div class="wrap">
  <h1>x402 Gateway</h1>
  <p>Register any upstream API with a price and get a hosted, pay-per-call endpoint settled in BSV sats — no Worker to deploy. Paid routes appear in <a href="https://entangleit.com/x402market/">x402market</a> so agents can discover and pay them.</p>

  <h2>Try a paid call</h2>
  <pre>curl -si ${base}/g/&lt;slug&gt;/&lt;tool&gt;
# HTTP/2 402 + PAYMENT-REQUIRED (price, payTo, bsv:mainnet)
# retry with PAYMENT-SIGNATURE and the upstream response comes back</pre>

  <h2>Register a service</h2>
  <div class="panel">
    <div class="grid">
      <div><label>Name</label><input id="name" placeholder="Weather Oracle"></div>
      <div><label>Your BSV payout address</label><input id="payTo" placeholder="1..."></div>
      <div><label>Upstream base URL (https)</label><input id="baseUrl" placeholder="https://api.example.com"></div>
      <div><label>Contact (optional)</label><input id="ownerContact" placeholder="you@example.com"></div>
      <div><label>Auth header (optional)</label><input id="authHeader" placeholder="Authorization"></div>
      <div><label>Auth value (optional)</label><input id="authValue" placeholder="Bearer sk-…"></div>
    </div>
    <label>Tagline</label><input id="tagline" placeholder="Ten words about it">
    <label>Description</label><textarea id="description" style="min-height:70px" placeholder="What buyers get"></textarea>
    <label>Routes (JSON array) — Free: up to 5 · Pro: 100 + analytics</label>
    <textarea id="routes">[
  { "name": "forecast", "method": "GET", "path": "/v1/forecast", "priceSats": 20, "description": "7-day forecast by city" },
  { "name": "health", "method": "GET", "path": "/healthz", "priceSats": 0, "description": "Free liveness check" }
]</textarea>
    <button id="submit">Register service</button>
    <div class="result" id="result"></div>
  </div>

  <h2>Live services</h2>
  <div class="panel"><table id="services"><tbody><tr><td>Loading…</td></tr></tbody></table></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function load() {
  const tbody = document.querySelector('#services tbody');
  try {
    const res = await fetch('${base}/api/services');
    const data = await res.json();
    if (!data.services?.length) { tbody.innerHTML = '<tr><td>No services yet — be the first.</td></tr>'; return; }
    tbody.innerHTML = data.services.map((s) => {
      const paid = s.routes.filter((r) => r.paid);
      const min = paid.length ? Math.min(...paid.map((r) => r.priceSats)) : null;
      return '<tr><td><strong>' + esc(s.name) + '</strong><br><span class="pill">' + esc(s.slug) + '</span> <a style="font-size:12px" href="${base}/dashboard?service=' + encodeURIComponent(s.slug) + '">dashboard</a></td>' +
        '<td>' + esc(s.tagline || '') + '<br><span class="pill">' + s.routes.length + ' routes</span> ' +
        (min !== null ? '<span class="pill">from ' + min + ' sats</span>' : '<span class="pill">free</span>') + '</td>' +
        '<td>' + s.totals.calls + ' calls · ' + s.totals.sats + ' sats</td></tr>';
    }).join('');
  } catch (e) { tbody.innerHTML = '<tr><td class="err">Could not load services.</td></tr>'; }
}

$('submit').addEventListener('click', async () => {
  const btn = $('submit');
  const out = $('result');
  btn.disabled = true;
  try {
    const routes = JSON.parse($('routes').value);
    const res = await fetch('${base}/api/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('name').value, tagline: $('tagline').value, description: $('description').value,
        baseUrl: $('baseUrl').value, payTo: $('payTo').value, ownerContact: $('ownerContact').value,
        authHeader: $('authHeader').value, authValue: $('authValue').value, routes,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    out.style.display = 'block';
    out.innerHTML = '<p class="ok">Registered · listed in x402market ' + (data.listing?.ok ? '✓' : '(pending: ' + esc(data.listing?.error || '') + ')') + '</p>' +
      '<p>Gateway base: <code>' + esc(data.gatewayBase) + '</code></p>' +
      '<p>Plan: <strong>Free</strong> · up to 5 routes · ' +
      '<button id="upgradeBtn" class="ghostBtn">Upgrade to Pro — $9/mo</button> ' +
      '<a class="ghostBtn" style="text-decoration:none" href="' + esc(data.dashboard || '#') + '">Open dashboard</a></p>' +
      '<p>Store this admin key now (shown once):</p><pre>' + esc(data.adminKey) + '</pre>';
    document.getElementById('upgradeBtn').onclick = async () => {
      const btn = document.getElementById('upgradeBtn');
      btn.disabled = true;
      try {
        const r = await fetch('${base}/api/services/' + encodeURIComponent(data.service.slug) + '/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': data.adminKey },
          body: JSON.stringify({ action: 'checkout' }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        window.location.href = j.url;
      } catch (e) {
        btn.disabled = false;
        alert('Upgrade error: ' + e.message);
      }
    };
    load();
  } catch (e) {
    out.style.display = 'block';
    out.innerHTML = '<p class="err">' + esc(e.message) + '</p>';
  } finally { btn.disabled = false; }
});

(function handleUpgradeReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get('upgrade');
  if (!status) return;
  const out = $('result');
  out.style.display = 'block';
  out.innerHTML = status === 'success'
    ? '<p class="ok">Payment received — Pro activates when Stripe confirms (usually seconds). Refresh in a moment.</p>'
    : '<p class="err">Upgrade cancelled — nothing was charged.</p>';
  history.replaceState({}, '', location.pathname);
})();

load();
</script>
<footer style="max-width:960px;margin:0 auto;padding:0 20px 40px;color:#8b97ab;font-size:13px">
  x402 Gateway · part of <a href="https://entangleit.com/">EntangleIT</a> —
  <a href="https://entangleit.com/agentpay/">agentpay</a> ·
  <a href="https://entangleit.com/x402market/">x402market</a> ·
  <a href="https://entangleit.com/bsvbounties/">BSVBounties</a>
</footer>
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"82070152b02a4a06a05d7ac15991ed63"}'></script>
</body></html>`;
}

// Mount at the root (workers.dev) and under /x402gateway (entangleit.com).
// `strict: false` keeps "/x402gateway/" and subpaths with trailing slashes working.
const app = new Hono<{ Bindings: Env }>({ strict: false });
app.route("/", api);
app.route("/x402gateway", api);

export default app;
