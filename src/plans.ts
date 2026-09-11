/**
 * Hosting tiers for gateway services.
 *
 * Free is the default: 5 routes per service and aggregate totals only.
 * Pro ($9/mo, PRO_PRICE_CENTS overrides) raises the cap to 100 routes and
 * unlocks the per-call analytics log + CSV export. Entitlements are derived
 * server-side from xgw_subscriptions, which only verified Stripe webhooks write.
 */
import type { Env } from "./x402.ts";

export type PlanId = "free" | "pro";

export interface PlanLimits {
  /** Maximum routes per service. */
  maxRoutes: number;
  /** Per-call analytics log + CSV export. */
  usageLog: boolean;
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  priceCents: number;
  features: string[];
  limits: PlanLimits;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    priceCents: 0,
    features: ["1 service registration flow", "Up to 5 routes", "Aggregate call + sats totals", "Listed in x402market"],
    limits: { maxRoutes: 5, usageLog: false },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceCents: 900,
    features: ["Up to 100 routes", "Per-call analytics log", "CSV export of calls", "Everything in Free"],
    limits: { maxRoutes: 100, usageLog: true },
  },
};

export const PLAN_LIMIT_CODE = "plan_limit";
const PRO_GRACE_MS = 72 * 60 * 60 * 1000;

export function proPriceCents(env: Pick<Env, "PRO_PRICE_CENTS">): number {
  const n = Number.parseInt(env.PRO_PRICE_CENTS ?? "", 10);
  return Number.isFinite(n) && n >= 100 ? n : PLANS.pro.priceCents;
}

export interface SubscriptionRow {
  service_id: string;
  plan: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  created_at: string;
  updated_at: string;
}

export interface PlanState {
  id: PlanId;
  subscribedPlan: PlanId;
  status: string;
  active: boolean;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  priceCents: number;
  limits: PlanLimits;
}

export interface D1Stmt {
  bind(...params: unknown[]): D1Stmt;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(query: string): D1Stmt;
}

export function subscriptionIsActive(
  status: string | null | undefined,
  currentPeriodEnd: string | null | undefined,
  now = Date.now(),
): boolean {
  const s = (status ?? "").toLowerCase();
  if (s !== "active" && s !== "trialing") return false;
  if (!currentPeriodEnd) return true;
  const end = Date.parse(currentPeriodEnd);
  return Number.isNaN(end) ? true : end + PRO_GRACE_MS > now;
}

export function planStateFromRow(
  row: SubscriptionRow | null,
  env?: Pick<Env, "PRO_PRICE_CENTS">,
): PlanState {
  const subscribedPlan: PlanId = row?.plan === "pro" ? "pro" : "free";
  const active = Boolean(row && subscribedPlan === "pro" && subscriptionIsActive(row.status, row.current_period_end));
  const id: PlanId = active ? "pro" : "free";
  return {
    id,
    subscribedPlan,
    status: row?.status ?? "none",
    active,
    currentPeriodEnd: row?.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end),
    priceCents: proPriceCents(env ?? {}),
    limits: PLANS[id].limits,
  };
}

export async function getSubscription(database: D1Like, serviceId: string): Promise<SubscriptionRow | null> {
  return database
    .prepare("SELECT * FROM xgw_subscriptions WHERE service_id = ?")
    .bind(serviceId)
    .first<SubscriptionRow>();
}

export async function getServicePlan(
  database: D1Like,
  serviceId: string,
  env?: Pick<Env, "PRO_PRICE_CENTS">,
): Promise<PlanState> {
  return planStateFromRow(await getSubscription(database, serviceId), env);
}

export async function upsertSubscription(
  database: D1Like,
  input: {
    serviceId: string;
    plan: PlanId;
    status: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    currentPeriodEnd?: string | null;
    cancelAtPeriodEnd?: boolean;
  },
): Promise<void> {
  const t = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO xgw_subscriptions (service_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(service_id) DO UPDATE SET
         plan = excluded.plan,
         status = excluded.status,
         stripe_customer_id = COALESCE(excluded.stripe_customer_id, xgw_subscriptions.stripe_customer_id),
         stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, xgw_subscriptions.stripe_subscription_id),
         current_period_end = COALESCE(excluded.current_period_end, xgw_subscriptions.current_period_end),
         cancel_at_period_end = excluded.cancel_at_period_end,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.serviceId,
      input.plan,
      input.status,
      input.stripeCustomerId ?? null,
      input.stripeSubscriptionId ?? null,
      input.currentPeriodEnd ?? null,
      input.cancelAtPeriodEnd ? 1 : 0,
      t,
      t,
    )
    .run();
}

/** Minimal row for a paid checkout; later subscription events fill in details. */
export async function ensureSubscription(
  database: D1Like,
  input: {
    serviceId: string;
    status: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
  },
): Promise<void> {
  const t = new Date().toISOString();
  await database
    .prepare(
      "INSERT OR IGNORE INTO xgw_subscriptions (service_id, plan, status, stripe_customer_id, stripe_subscription_id, created_at, updated_at) VALUES (?, 'pro', ?, ?, ?, ?, ?)",
    )
    .bind(input.serviceId, input.status, input.stripeCustomerId ?? null, input.stripeSubscriptionId ?? null, t, t)
    .run();
}

export async function findServiceByStripe(
  database: D1Like,
  ids: { subscriptionId?: string | null; customerId?: string | null },
): Promise<string | null> {
  if (ids.subscriptionId) {
    const row = await database
      .prepare("SELECT service_id FROM xgw_subscriptions WHERE stripe_subscription_id = ? LIMIT 1")
      .bind(ids.subscriptionId)
      .first<{ service_id: string }>();
    if (row?.service_id) return row.service_id;
  }
  if (ids.customerId) {
    const row = await database
      .prepare("SELECT service_id FROM xgw_subscriptions WHERE stripe_customer_id = ? LIMIT 1")
      .bind(ids.customerId)
      .first<{ service_id: string }>();
    if (row?.service_id) return row.service_id;
  }
  return null;
}

export async function updateStatusByCustomer(
  database: D1Like,
  customerId: string,
  status: string,
): Promise<boolean> {
  const res = (await database
    .prepare("UPDATE xgw_subscriptions SET status = ?, updated_at = ? WHERE stripe_customer_id = ?")
    .bind(status, new Date().toISOString(), customerId)
    .run()) as { meta?: { changes?: number } };
  return (res.meta?.changes ?? 0) > 0;
}

export async function setStripeCustomerId(
  database: D1Like,
  serviceId: string,
  customerId: string | null,
): Promise<void> {
  await database
    .prepare("UPDATE xgw_subscriptions SET stripe_customer_id = ?, updated_at = ? WHERE service_id = ?")
    .bind(customerId, new Date().toISOString(), serviceId)
    .run();
}
