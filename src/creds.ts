/**
 * Gateway credential encryption — upstream auth secrets at rest.
 *
 * auth_value is AES-256-GCM encrypted under GATEWAY_CREDS_KEY (base64,
 * 32 bytes), envelope JSON {v:1,iv,ct}. Header names stay plaintext.
 * Legacy plaintext rows (pre-key) decrypt by passthrough and are
 * re-encrypted on next admin write. Admin keys are SHA-256 hashes with an
 * ADMIN_SECRET pepper when set (dual-check accepts legacy unpeppered).
 */
import type { Env } from "./x402.ts";

const te = new TextEncoder();
const td = new TextDecoder();

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function credsKeyConfigured(env: Env): boolean {
  return typeof env.GATEWAY_CREDS_KEY === "string" && env.GATEWAY_CREDS_KEY.length > 0;
}

async function credsAesKey(env: Env): Promise<CryptoKey> {
  const raw = (env.GATEWAY_CREDS_KEY ?? "").trim();
  if (!raw) throw new Error("GATEWAY_CREDS_KEY is not configured");
  const bytes = b64decode(raw);
  if (bytes.length !== 32) throw new Error("GATEWAY_CREDS_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptAuthValue(env: Env, plaintext: string): Promise<string> {
  if (!plaintext) return "";
  if (!credsKeyConfigured(env)) return plaintext; // legacy passthrough until key set
  const key = await credsAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    te.encode(plaintext).buffer as ArrayBuffer,
  );
  return JSON.stringify({ v: 1, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) });
}

export async function decryptAuthValue(env: Env, stored: string): Promise<string> {
  if (!stored) return "";
  let env2: { v?: number; iv?: string; ct?: string } | null = null;
  try {
    const parsed = JSON.parse(stored) as { v?: number; iv?: string; ct?: string };
    if (parsed && parsed.v === 1 && typeof parsed.iv === "string" && typeof parsed.ct === "string") env2 = parsed;
  } catch {
    env2 = null;
  }
  if (!env2) return stored; // legacy plaintext passthrough
  const key = await credsAesKey(env);
  const ivBytes = b64decode(env2.iv!);
  const ctBytes = b64decode(env2.ct!);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes.buffer as ArrayBuffer },
    key,
    ctBytes.buffer as ArrayBuffer,
  );
  return td.decode(pt);
}

export function isEncryptedAuthValue(stored: string): boolean {
  if (!stored) return false;
  try {
    const p = JSON.parse(stored) as { v?: number };
    return p?.v === 1;
  } catch {
    return false;
  }
}
