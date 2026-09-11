/**
 * Stripe subscriptions for gateway hosting tiers.
 * Checkout uses dynamic payment methods and ad-hoc monthly pricing unless
 * STRIPE_PRICE_GATEWAY_PRO is set. Webhooks are signature-verified, claimed
 * once, and released on failure so Stripe retries can apply.
 */
import Stripe from "stripe";
import type { Env } from "./x402.ts";
import { HttpError } from "./store.ts";
import {
  ensureSubscription,
  findServiceByStripe,
  proPriceCents,
  updateStatusByCustomer,
  upsertSubscription,
  type D1Like,
} from "./plans.ts";

interface ServiceLike {
  id: string;
  slug: string;
  name: string;
  owner_contact: string;
}

export function stripeConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export function stripeClient(env: Env): Stripe {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(503, "Stripe is not configured");
  return new Stripe(key, {
    apiVersion: "2026-08-26.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function stripeKeyLivemode(key: string | null | undefined): boolean | null {
  if (!key) return null;
  if (key.includes("_live_")) return true;
  if (key.includes("_test_")) return false;
  return null;
}

export function stripeEnvLivemode(env: Env): boolean | null {
  return stripeKeyLivemode(env.STRIPE_SECRET_KEY);
}

/** Production hostname must not charge in Stripe test mode. */
export function productionRequiresLiveStripe(hostname: string, livemode: boolean | null): boolean {
  return hostname === "entangleit.com" && livemode !== true;
}

function throwStripe(err: unknown): never {
  const message =
    err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : null;
  if (message) throw new HttpError(502, message.slice(0, 300));
  throw err;
}

function assertLiveOnProduction(origin: string, env: Env): void {
  const livemode = stripeEnvLivemode(env);
  if (productionRequiresLiveStripe(new URL(origin).hostname, livemode)) {
    throw new HttpError(503, "Production Checkout requires live Stripe keys");
  }
}

function integrationIdentifier(prefix: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let suffix = "";
  for (const b of buf) suffix += alphabet[b % alphabet.length];
  return `${prefix}_${suffix}`;
}

async function ensureCustomer(env: Env, stripe: Stripe, service: ServiceLike): Promise<string> {
  const db = env.DB as D1Like;
  const existing = await db
    .prepare("SELECT stripe_customer_id FROM xgw_subscriptions WHERE service_id = ?")
    .bind(service.id)
    .first<{ stripe_customer_id: string | null }>();
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;
  const email = /@/.test(service.owner_contact) ? service.owner_contact : undefined;
  const customer = await stripe.customers
    .create({
      metadata: { gatewayServiceId: service.id, slug: service.slug },
      email,
      name: service.name,
    })
    .catch(throwStripe);
  return customer.id;
}

export async function createProCheckout(
  env: Env,
  service: ServiceLike,
  origin: string,
): Promise<{ url: string; sessionId: string; priceCents: number }> {
  if (!stripeConfigured(env)) throw new HttpError(503, "Stripe is not configured");
  assertLiveOnProduction(origin, env);
  const priceCents = proPriceCents(env);
  const stripe = stripeClient(env);
  const customer = await ensureCustomer(env, stripe, service);
  const cleanOrigin = origin.replace(/\/$/, "");
  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = env.STRIPE_PRICE_GATEWAY_PRO
    ? { quantity: 1, price: env.STRIPE_PRICE_GATEWAY_PRO }
    : {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: priceCents,
          recurring: { interval: "month" },
          product_data: {
            name: "x402 Gateway Pro",
            description: "100 routes, per-call analytics, CSV export",
          },
        },
      };
  const session = await stripe.checkout.sessions
    .create({
      mode: "subscription",
      customer,
      client_reference_id: service.id,
      line_items: [lineItem],
      success_url: `${cleanOrigin}/?upgrade=success&service=${encodeURIComponent(service.slug)}`,
      cancel_url: `${cleanOrigin}/?upgrade=cancel&service=${encodeURIComponent(service.slug)}`,
      metadata: { kind: "gateway_pro", serviceId: service.id, slug: service.slug },
      subscription_data: { metadata: { serviceId: service.id, slug: service.slug } },
      integration_identifier: integrationIdentifier("x402gw_pro"),
    })
    .catch(throwStripe);
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL");

  // Keep the customer on file before payment; later events complete the state.
  await upsertSubscription(env.DB as D1Like, {
    serviceId: service.id,
    plan: "pro",
    status: "incomplete",
    stripeCustomerId: customer,
  });
  return { url: session.url, sessionId: session.id, priceCents };
}

export async function createBillingPortal(
  env: Env,
  service: ServiceLike,
  origin: string,
): Promise<{ url: string }> {
  if (!stripeConfigured(env)) throw new HttpError(503, "Stripe is not configured");
  assertLiveOnProduction(origin, env);
  const db = env.DB as D1Like;
  const row = await db
    .prepare("SELECT stripe_customer_id FROM xgw_subscriptions WHERE service_id = ?")
    .bind(service.id)
    .first<{ stripe_customer_id: string | null }>();
  if (!row?.stripe_customer_id) throw new HttpError(400, "No Stripe customer on file yet — upgrade first");
  const stripe = stripeClient(env);
  const session = await stripe.billingPortal.sessions
    .create({
      customer: row.stripe_customer_id,
      return_url: `${origin.replace(/\/$/, "")}/?billing=return`,
    })
    .catch(throwStripe);
  return { url: session.url };
}

// ---------- webhooks ----------

interface StripeSubscriptionShape {
  id: string;
  status: string;
  customer?: string | { id?: string };
  metadata?: Record<string, string>;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  items?: { data?: { current_period_end?: number }[] };
}

function stripeId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return null;
}

function subscriptionFields(sub: StripeSubscriptionShape) {
  const item = sub.items?.data?.[0];
  const periodEnd = sub.current_period_end ?? item?.current_period_end ?? null;
  return {
    serviceId: sub.metadata?.serviceId ?? null,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: stripeId(sub.customer),
    status: sub.status,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  };
}

async function claimEvent(db: D1Like, id: string, type: string): Promise<boolean> {
  const res = (await db
    .prepare("INSERT OR IGNORE INTO xgw_stripe_events (id, type) VALUES (?, ?)")
    .bind(id, type)
    .run()) as { meta?: { changes?: number } };
  return (res.meta?.changes ?? 0) === 1;
}

async function releaseEvent(db: D1Like, id: string): Promise<void> {
  await db.prepare("DELETE FROM xgw_stripe_events WHERE id = ?").bind(id).run().catch(() => undefined);
}

async function processEvent(env: Env, event: Stripe.Event): Promise<void> {
  const db = env.DB as D1Like;

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription") return;
      const serviceId = session.metadata?.serviceId ?? null;
      if (!serviceId) return;
      const customerId = stripeId(session.customer);
      const subscriptionId = stripeId(session.subscription);
      await ensureSubscription(db, {
        serviceId,
        status: session.payment_status === "paid" || session.payment_status === "no_payment_required" ? "active" : "incomplete",
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
      });
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const fields = subscriptionFields(event.data.object as unknown as StripeSubscriptionShape);
      const serviceId =
        fields.serviceId ??
        (await findServiceByStripe(db, {
          subscriptionId: fields.stripeSubscriptionId,
          customerId: fields.stripeCustomerId,
        }));
      if (!serviceId) return;
      await upsertSubscription(db, {
        serviceId,
        plan: "pro",
        status: event.type === "customer.subscription.deleted" ? "canceled" : fields.status,
        stripeCustomerId: fields.stripeCustomerId,
        stripeSubscriptionId: fields.stripeSubscriptionId,
        currentPeriodEnd: fields.currentPeriodEnd,
        cancelAtPeriodEnd: event.type === "customer.subscription.deleted" ? false : fields.cancelAtPeriodEnd,
      });
      return;
    }

    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object as { customer?: string | { id?: string } };
      const customerId = stripeId(invoice.customer);
      if (!customerId) return;
      await updateStatusByCustomer(db, customerId, event.type === "invoice.paid" ? "active" : "past_due");
      return;
    }

    default:
      return;
  }
}

export async function handleStripeEvent(env: Env, event: Stripe.Event): Promise<void> {
  const db = env.DB as D1Like;
  const claimed = await claimEvent(db, event.id, event.type);
  if (!claimed) return;
  try {
    await processEvent(env, event);
  } catch (err) {
    await releaseEvent(db, event.id);
    console.error("[x402-gateway-stripe]", event.type, err);
    throw err;
  }
}
