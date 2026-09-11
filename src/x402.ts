/**
 * Strict x402 v2 (exact × bsv:mainnet) seller helpers for the gateway.
 * Same binding as bsv-wallets / x402-seller-kit: no keys here — the gateway
 * verifies buyer-signed transactions and broadcasts them via ARC.
 */
import { Transaction } from "@bsv/sdk";

export const X402_VERSION = 2;
export const BSV_SCHEME = "exact";
export const BSV_NETWORK = "bsv:mainnet";
export const BSV_ASSET = "native:BSV";

export interface BsvPaymentRequirements {
  x402Version: number;
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  asset: string;
  resource: { url: string; description: string; mimeType: string };
  extra: { satoshis: string; dustFloor: string; arcUrl: string };
}

export interface BsvPaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  txHex: string;
  encoding: "raw-hex" | "beef-hex";
}

export interface Env {
  DB: unknown;
  METER?: unknown;
  PUBLIC_SITE?: string;
  PUBLIC_BASE?: string;
  WORKERS_DEV_BASE?: string;
  ARC_URL?: string;
  ARC_API_KEY?: string;
  /** Stripe secret key (rk_live_… / rk_test_…) for gateway Pro subscriptions. */
  STRIPE_SECRET_KEY?: string;
  /** Signing secret of the /webhooks/stripe endpoint. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Optional pre-created recurring price for Gateway Pro. */
  STRIPE_PRICE_GATEWAY_PRO?: string;
  /** Optional pre-created recurring ANNUAL price for Gateway Pro. */
  STRIPE_PRICE_GATEWAY_PRO_ANNUAL?: string;
  /** Monthly Gateway Pro price in USD cents (default 900 = $9). */
  PRO_PRICE_CENTS?: string;
  /** Resend API key for Watch alert emails (optional — webhooks still work). */
  RESEND_API_KEY?: string;
  /** From header for Watch alert emails. */
  WATCH_ALERT_FROM?: string;
  /** Watch tuning knobs (all have code defaults): check intervals in minutes. */
  WATCH_FREE_INTERVAL_MIN?: string;
  WATCH_PRO_INTERVAL_MIN?: string;
  /** Max watches checked per cron tick (default 50). */
  WATCH_MAX_PER_RUN?: string;
  /** Check-history retention in days (defaults: 7 free, 90 pro). */
  WATCH_FREE_HISTORY_DAYS?: string;
  WATCH_PRO_HISTORY_DAYS?: string;
  /** Per-probe timeout in ms (default 10000). */
  WATCH_CHECK_TIMEOUT_MS?: string;
  MAX_ROUTES_PER_SERVICE?: string;
  MAX_SERVICES_PER_IP_PER_DAY?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  MAX_RESPONSE_BYTES?: string;
  MAX_REQUEST_BYTES?: string;
  RATE_LIMIT_PER_MIN?: string;
  /** Base URL of the agentpay API for trust-attestation verification. */
  AGENTPAY_PUBLIC_URL?: string;
  /** Base64 32-byte AES-GCM key encrypting upstream auth secrets at rest. */
  GATEWAY_CREDS_KEY?: string;
  /** Pepper for admin-key hashes (dual-check accepts legacy unpeppered). */
  ADMIN_SECRET?: string;
}

const te = new TextEncoder();
const td = new TextDecoder();

export function b64encodeJson(obj: unknown): string {
  const bytes = te.encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decodeJson<T>(b64: string): T {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(td.decode(bytes)) as T;
}

export function buildRequirements(args: {
  url: string;
  description: string;
  satoshis: number;
  payTo: string;
  arcUrl: string;
}): BsvPaymentRequirements {
  return {
    x402Version: X402_VERSION,
    scheme: BSV_SCHEME,
    network: BSV_NETWORK,
    amount: String(args.satoshis),
    payTo: args.payTo,
    asset: BSV_ASSET,
    resource: { url: args.url, description: args.description, mimeType: "application/json" },
    extra: { satoshis: String(args.satoshis), dustFloor: "1", arcUrl: args.arcUrl },
  };
}

export type VerifyResult =
  | { success: true; payer: string; txid: string; txHex: string; amount: number }
  | { success: false; errorReason: string };

const fail = (errorReason: string): VerifyResult => ({ success: false, errorReason });

/** Structural verify: envelope matches, tx pays payTo >= amount, sane totals. */
export async function verifyBsvPayment(
  requirements: BsvPaymentRequirements,
  payload: BsvPaymentPayload,
): Promise<VerifyResult> {
  if (requirements.x402Version !== X402_VERSION) return fail("invalid_x402_version");
  if (requirements.scheme !== BSV_SCHEME) return fail("invalid_scheme");
  if (requirements.network !== BSV_NETWORK) return fail("invalid_network");
  const want = Number.parseInt(requirements.amount, 10);
  if (!Number.isFinite(want) || want <= 0) return fail("invalid_payment_requirements");
  if (!requirements.payTo || requirements.payTo.length < 26) return fail("invalid_payment_requirements");
  if (payload.x402Version !== X402_VERSION || payload.scheme !== BSV_SCHEME || payload.network !== BSV_NETWORK) {
    return fail("invalid_payload");
  }
  if (!payload.txHex || payload.txHex.length < 100 || payload.txHex.length > 2_000_000) {
    return fail("invalid_payload");
  }

  let tx: Transaction;
  try {
    tx = Transaction.fromHex(payload.txHex);
  } catch {
    return fail("invalid_payload");
  }

  let paid = 0;
  let txid = "";
  try {
    txid = tx.id("hex");
    const { P2PKH } = await import("@bsv/sdk");
    const expected = new P2PKH().lock(requirements.payTo).toHex();
    for (const out of tx.outputs) {
      try {
        if (out.lockingScript.toHex() === expected) paid += out.satoshis ?? 0;
      } catch {
        continue;
      }
    }
  } catch {
    return fail("invalid_payload");
  }
  if (paid < want) return fail("invalid_exact_bsv_payment_recipient_mismatch");

  let outTotal = 0;
  for (const o of tx.outputs) outTotal += o.satoshis ?? 0;
  if (outTotal <= 0 || outTotal > 100_000_000) return fail("invalid_payload");

  let payer = "bsv:unknown";
  if (tx.inputs.length > 0) {
    const first = tx.inputs[0]!;
    const ref = first.sourceTXID ?? first.sourceTransaction?.id("hex") ?? "";
    if (ref) payer = `bsv:input:${ref.slice(0, 16)}`;
  }
  return { success: true, payer, txid, txHex: payload.txHex, amount: paid };
}

export async function arcBroadcast(env: Env, rawTxHex: string): Promise<{ txid: string }> {
  const base = (env.ARC_URL || "https://arc.gorillapool.io/v1").replace(/\/$/, "");
  const apiKey = typeof env.ARC_API_KEY === "string" ? env.ARC_API_KEY : "";
  const res = await fetch(`${base}/tx`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}`, "X-API-Key": apiKey, api_key: apiKey } : {}),
      "XDeployment-ID": "x402-gateway-v1",
    },
    body: JSON.stringify({ rawTx: rawTxHex }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text.slice(0, 2000) };
  }
  if (!res.ok) {
    const err = new Error(`ARC rejected (${res.status}): ${text.slice(0, 400)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const txid = (json["txid"] as string) ?? (json["txId"] as string) ?? (json["hash"] as string) ?? "";
  return { txid };
}

interface ReplayKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/** One txid pays for exactly one call. Fails open when KV is not bound. */
export async function claimPaymentTxid(env: Env, txid: string): Promise<boolean> {
  const kv = env.METER as ReplayKV | undefined;
  if (!kv) return true;
  const key = `xgw:replay:${txid}`;
  const seen = await kv.get(key);
  if (seen) return false;
  await kv.put(key, "1", { expirationTtl: 90 * 24 * 3600 });
  return true;
}
