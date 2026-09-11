/**
 * Seller-enforced trust discounts (Phase E).
 *
 * Buyers send X-Trust-Attestation: b64({attestation, signature, keyId}).
 * The gateway verifies the agentpay ECDSA signature offline, checks the
 * claimant binding (attestation.sub must equal the verified payment payer),
 * and applies the route's trustDiscountBps to the challenged price.
 * Thresholds mirror @ai-bounties/shared trust gates. Fail closed: any
 * verification problem means full price, never an error.
 */
import type { Env } from "./x402.ts";

export const TRUST_HEADER = "X-Trust-Attestation";
const MIN_PAYMENTS = 10;
const MIN_SERVICES = 3;
const MIN_SPENT_CENTS = 50;
const MIN_WALLET_AGE_MS = 7 * 86_400_000;
const MAX_SIG_AGE_MS = 24 * 3_600_000;

interface Metrics {
  settledPayments?: number;
  distinctServices?: number;
  distinctPayTo?: number;
  spentCents?: number;
  refundedCents?: number;
  firstPaymentAt?: string | null;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let keyCache: { at: number; jwk: JsonWebKey; keyId: string } | null = null;
const KEY_TTL_MS = 3_600_000;

async function agentpayKey(env: Env): Promise<{ jwk: JsonWebKey; keyId: string } | null> {
  if (keyCache && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache;
  const base = (env.AGENTPAY_PUBLIC_URL || "https://entangleit.com/api/agentpay").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/attestations/key`);
    if (!res.ok) return keyCache;
    const body = (await res.json()) as { publicJwk?: JsonWebKey; keyId?: string };
    if (!body.publicJwk || typeof body.keyId !== "string") return keyCache;
    keyCache = { at: Date.now(), jwk: body.publicJwk, keyId: body.keyId };
    return keyCache;
  } catch {
    return keyCache;
  }
}

export function discountSats(priceSats: number, discountBps: number): number {
  if (!Number.isInteger(priceSats) || priceSats <= 0) return priceSats;
  const bps = Math.min(10_000, Math.max(0, Math.floor(discountBps)));
  if (bps <= 0) return priceSats;
  const eff = priceSats - Math.floor((priceSats * bps) / 10_000);
  return eff >= 1 ? eff : priceSats;
}

export async function verifyTrustForDiscount(
  env: Env,
  rawHeader: string | undefined,
  expectedPayer: string | null,
): Promise<{ eligible: boolean; reason: string }> {
  if (!rawHeader) return { eligible: false, reason: "no_attestation" };
  let envelope: { attestation?: Record<string, unknown>; signature?: string };
  try {
    envelope = JSON.parse(new TextDecoder().decode(b64ToBytes(rawHeader))) as {
      attestation?: Record<string, unknown>;
      signature?: string;
    };
  } catch {
    return { eligible: false, reason: "bad_envelope" };
  }
  const att = envelope.attestation;
  if (!att || typeof envelope.signature !== "string") return { eligible: false, reason: "bad_envelope" };
  const key = await agentpayKey(env);
  if (!key) return { eligible: false, reason: "key_unavailable" };
  try {
    const pub = await crypto.subtle.importKey("jwk", key.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    const sig = b64ToBytes(envelope.signature);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      sig.buffer as ArrayBuffer,
      new TextEncoder().encode(stableStringify(att)).buffer as ArrayBuffer,
    );
    if (!ok) return { eligible: false, reason: "bad_signature" };
  } catch {
    return { eligible: false, reason: "bad_signature" };
  }
  // Binding: sub must equal the payer derived from the payment tx (or, on
  // the unsigned first call, the check is deferred — see proxyRoute).
  if (expectedPayer && typeof att.sub === "string" && att.sub !== expectedPayer) {
    return { eligible: false, reason: "sub_mismatch" };
  }
  const now = Date.now();
  if (typeof att.expiresAt === "string" && Number.isFinite(Date.parse(att.expiresAt)) && Date.parse(att.expiresAt) <= now) {
    return { eligible: false, reason: "expired" };
  }
  if (typeof att.issuedAt === "string" && Number.isFinite(Date.parse(att.issuedAt)) && now - Date.parse(att.issuedAt) > MAX_SIG_AGE_MS) {
    return { eligible: false, reason: "stale" };
  }
  const m = (att.metrics ?? {}) as Metrics;
  if (typeof m.settledPayments !== "number" || m.settledPayments < MIN_PAYMENTS) {
    return { eligible: false, reason: "too_few_payments" };
  }
  if (typeof m.distinctServices !== "number" || m.distinctServices < MIN_SERVICES) {
    return { eligible: false, reason: "too_few_services" };
  }
  if (typeof m.distinctPayTo === "number" && m.distinctPayTo < MIN_SERVICES) {
    return { eligible: false, reason: "too_few_payees" };
  }
  if (typeof m.spentCents !== "number" || m.spentCents < MIN_SPENT_CENTS) {
    return { eligible: false, reason: "spend_too_low" };
  }
  if (typeof m.firstPaymentAt === "string" && m.firstPaymentAt && Number.isFinite(Date.parse(m.firstPaymentAt))) {
    if (now - Date.parse(m.firstPaymentAt) < MIN_WALLET_AGE_MS) return { eligible: false, reason: "wallet_too_new" };
  }
  if (typeof m.refundedCents === "number" && m.refundedCents > 0) {
    return { eligible: false, reason: "has_refunds" };
  }
  return { eligible: true, reason: "trusted_spender" };
}
