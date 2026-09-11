/**
 * Gateway store: validation, slugs, D1 helpers, and the SSRF guard.
 * Upstream credentials are stored server-side (needed to sign requests) and
 * never returned by any API after creation.
 */
import { P2PKH } from "@bsv/sdk";
import type { Env } from "./x402.ts";

export class HttpError extends Error {
  status: number;
  payload?: Record<string, unknown>;

  constructor(status: number, message: string, payload?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.payload = payload;
  }
}

export interface GatewayRoute {
  name: string;
  method: "GET" | "POST";
  /** Upstream path, e.g. "/repos/anomalyco/opencode" */
  path: string;
  priceSats: number;
  description: string;
}

export interface ServiceRow {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  base_url: string;
  auth_header: string;
  auth_value: string;
  pay_to: string;
  owner_contact: string;
  admin_key_hash: string;
  status: "active" | "paused";
  routes_json: string;
  registry_id: string;
  total_calls: number;
  total_sats: number;
  created_at: string;
  updated_at: string;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ROUTE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const RESERVED_ROUTE_NAMES = new Set(["manifest", "health", "admin"]);
export const BLOCKED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "cf-connecting-ip",
  "cf-ray",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);
export const MAX_PRICE_SATS = 1_000_000;
const ALLOWED_METHODS = new Set(["GET", "POST"]);

// ---------- basic helpers ----------

export function cleanStr(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${[...rand].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function mintAdminKey(): string {
  const rand = crypto.getRandomValues(new Uint8Array(24));
  return `xgw_admin_${[...rand].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function isValidPayTo(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 26 || value.length > 35) return false;
  try {
    new P2PKH().lock(value);
    return true;
  } catch {
    return false;
  }
}

// ---------- SSRF guard ----------

/** Block loopback, private, link-local, and internal names before fetching. */
export function isPrivateHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    return true;
  }
  if (host === "0.0.0.0" || host === "::1" || host === "::") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^fc[0-9a-f]{2}:/i.test(host) || /^fd[0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true;
  return false;
}

export function parseBaseUrl(value: unknown): string {
  const raw = cleanStr(value, 500);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "baseUrl must be a valid https:// URL");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "baseUrl must use https://");
  if (url.username || url.password) throw new HttpError(400, "baseUrl must not contain credentials");
  if (url.search || url.hash) throw new HttpError(400, "baseUrl must not contain a query or fragment");
  if (isPrivateHost(url)) throw new HttpError(400, "baseUrl points to a private or local host");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// ---------- service validation ----------

export interface ServiceInput {
  name: string;
  tagline: string;
  description: string;
  baseUrl: string;
  payTo: string;
  ownerContact: string;
  authHeader: string;
  authValue: string;
  routes: GatewayRoute[];
}

export function validateServiceInput(raw: unknown, maxRoutes: number): ServiceInput {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = cleanStr(body.name, 60);
  if (name.length < 2) throw new HttpError(400, "name is required (2–60 chars)");
  const tagline = cleanStr(body.tagline, 120);
  const description = cleanStr(body.description, 2000);
  if (!isValidPayTo(body.payTo)) throw new HttpError(400, "payTo must be a valid BSV P2PKH address");
  const ownerContact = cleanStr(body.ownerContact, 160);

  let authHeader = cleanStr(body.authHeader, 60);
  const authValue = cleanStr(body.authValue, 500);
  if (authHeader) {
    if (!/^[A-Za-z0-9-]+$/.test(authHeader) || BLOCKED_HEADERS.has(authHeader.toLowerCase())) {
      throw new HttpError(400, `authHeader "${authHeader}" is not allowed`);
    }
    if (authHeader.toLowerCase().startsWith("cf-")) {
      throw new HttpError(400, "authHeader must not start with cf-");
    }
    if (!authValue) throw new HttpError(400, "authValue is required when authHeader is set");
  } else if (authValue) {
    throw new HttpError(400, "authValue requires authHeader");
  }

  const rawRoutes = Array.isArray(body.routes) ? body.routes : [];
  if (rawRoutes.length < 1) throw new HttpError(400, "at least one route is required");
  if (rawRoutes.length > maxRoutes) throw new HttpError(400, `too many routes (max ${maxRoutes})`);
  const routes: GatewayRoute[] = [];
  const seen = new Set<string>();
  for (const item of rawRoutes) {
    const route = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const routeName = cleanStr(route.name, 40).toLowerCase();
    if (!ROUTE_NAME_RE.test(routeName)) throw new HttpError(400, `route name "${routeName}" must be lowercase letters, digits, dashes`);
    if (RESERVED_ROUTE_NAMES.has(routeName)) throw new HttpError(400, `route name "${routeName}" is reserved`);
    if (seen.has(routeName)) throw new HttpError(400, `duplicate route name "${routeName}"`);
    seen.add(routeName);
    const method = cleanStr(route.method, 10).toUpperCase();
    if (!ALLOWED_METHODS.has(method)) throw new HttpError(400, `route "${routeName}" method must be GET or POST`);
    const path = cleanStr(route.path, 300);
    if (!path.startsWith("/") || path.includes("//") || path.split("/").some((s) => s === "..")) {
      throw new HttpError(400, `route "${routeName}" path must start with / and contain no ".." segments`);
    }
    // Optional `{param}` placeholders are filled from caller query parameters.
    const placeholderOk = path.replace(/\{[a-z0-9_]{1,30}\}/g, "").indexOf("{") === -1;
    if (!placeholderOk) {
      throw new HttpError(400, `route "${routeName}" has an invalid {param} placeholder`);
    }
    const priceSats = Number(route.priceSats);
    if (!Number.isInteger(priceSats) || priceSats < 0 || priceSats > MAX_PRICE_SATS) {
      throw new HttpError(400, `route "${routeName}" priceSats must be 0..${MAX_PRICE_SATS}`);
    }
    routes.push({
      name: routeName,
      method: method as "GET" | "POST",
      path,
      priceSats,
      description: cleanStr(route.description, 160),
    });
  }

  return { name, tagline, description, baseUrl: parseBaseUrl(body.baseUrl), payTo: body.payTo as string, ownerContact, authHeader, authValue, routes };
}

export function routesOf(row: ServiceRow): GatewayRoute[] {
  try {
    const parsed = JSON.parse(row.routes_json) as unknown;
    return Array.isArray(parsed) ? (parsed as GatewayRoute[]) : [];
  } catch {
    return [];
  }
}

export function publicService(row: ServiceRow, base: string, plan?: Record<string, unknown>) {
  const routes = routesOf(row);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    payTo: row.pay_to,
    ownerContact: row.owner_contact,
    status: row.status,
    baseUrl: row.base_url,
    registryId: row.registry_id || null,
    createdAt: row.created_at,
    totals: { calls: row.total_calls, sats: row.total_sats },
    ...(plan ? { plan } : {}),
    routes: routes.map((r) => ({
      ...r,
      paid: r.priceSats > 0,
      url: `${base}/${row.slug}/${r.name}`,
    })),
  };
}

// ---------- D1 helpers ----------

interface D1StmtLike {
  bind(...params: unknown[]): D1StmtLike;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
interface D1Like {
  prepare(query: string): D1StmtLike;
}

export function db(env: Env): D1Like {
  return env.DB as D1Like;
}

export async function getServiceBySlug(database: D1Like, slug: string): Promise<ServiceRow | null> {
  return database.prepare("SELECT * FROM xgw_services WHERE slug = ?").bind(slug).first<ServiceRow>();
}

export async function getServiceById(database: D1Like, id: string): Promise<ServiceRow | null> {
  return database.prepare("SELECT * FROM xgw_services WHERE id = ?").bind(id).first<ServiceRow>();
}

export async function listServices(database: D1Like, limit = 100): Promise<ServiceRow[]> {
  const { results } = await database
    .prepare("SELECT * FROM xgw_services WHERE status = 'active' ORDER BY total_calls DESC, created_at DESC LIMIT ?")
    .bind(limit)
    .all<ServiceRow>();
  return results ?? [];
}

export async function uniqueSlug(database: D1Like, name: string): Promise<string> {
  const base = slugify(name) || `service-${Math.floor(Math.random() * 9000) + 1000}`;
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 36)}-${i + 1}`;
    const existing = await getServiceBySlug(database, candidate);
    if (!existing) return candidate;
  }
  return `${base.slice(0, 30)}-${Date.now().toString(36)}`;
}

export async function createService(
  database: D1Like,
  input: ServiceInput,
  adminKeyHash: string,
  slug: string,
): Promise<ServiceRow> {
  const id = newId("xgw");
  const t = nowIso();
  await database
    .prepare(
      `INSERT INTO xgw_services (id, slug, name, tagline, description, base_url, auth_header, auth_value, pay_to, owner_contact, admin_key_hash, status, routes_json, registry_id, total_calls, total_sats, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, '', 0, 0, ?, ?)`,
    )
    .bind(
      id,
      slug,
      input.name,
      input.tagline,
      input.description,
      input.baseUrl,
      input.authHeader,
      input.authValue,
      input.payTo,
      input.ownerContact,
      adminKeyHash,
      JSON.stringify(input.routes),
      t,
      t,
    )
    .run();
  const row = await getServiceById(database, id);
  if (!row) throw new HttpError(500, "Service insert failed");
  return row;
}

export async function requireAdmin(database: D1Like, slug: string, adminKey: string): Promise<ServiceRow> {
  const row = await getServiceBySlug(database, slug);
  if (!row) throw new HttpError(404, "Service not found");
  const hash = await sha256Hex(adminKey);
  if (hash !== row.admin_key_hash) throw new HttpError(403, "Invalid admin key");
  return row;
}

export async function updateService(
  database: D1Like,
  row: ServiceRow,
  patch: Partial<Pick<ServiceRow, "name" | "tagline" | "description" | "status" | "owner_contact" | "registry_id" | "auth_header" | "auth_value" | "pay_to" | "base_url" | "routes_json">>,
): Promise<ServiceRow> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return row;
  fields.push("updated_at = ?");
  values.push(nowIso());
  values.push(row.id);
  await database.prepare(`UPDATE xgw_services SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  const fresh = await getServiceById(database, row.id);
  if (!fresh) throw new HttpError(500, "Service update failed");
  return fresh;
}

export async function deleteService(database: D1Like, id: string): Promise<void> {
  await database.prepare("DELETE FROM xgw_services WHERE id = ?").bind(id).run();
}

export async function recordUsage(
  database: D1Like,
  input: { serviceId: string; route: string; payer: string; sats: number; txid: string; status: number; ms: number },
): Promise<void> {
  await database
    .prepare(
      "INSERT INTO xgw_usage (id, service_id, route, payer, sats, txid, status, ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(newId("xgu"), input.serviceId, input.route, input.payer, input.sats, input.txid, input.status, input.ms, nowIso())
    .run();
  if (input.sats > 0) {
    await database
      .prepare("UPDATE xgw_services SET total_calls = total_calls + 1, total_sats = total_sats + ?, updated_at = ? WHERE id = ?")
      .bind(input.sats, nowIso(), input.serviceId)
      .run();
  } else {
    await database
      .prepare("UPDATE xgw_services SET total_calls = total_calls + 1, updated_at = ? WHERE id = ?")
      .bind(nowIso(), input.serviceId)
      .run();
  }
}

export interface UsageRow {
  id: string;
  service_id: string;
  route: string;
  payer: string;
  sats: number;
  txid: string;
  status: number;
  ms: number;
  created_at: string;
}

export async function listUsage(database: D1Like, serviceId: string, limit = 25): Promise<UsageRow[]> {
  const { results } = await database
    .prepare("SELECT * FROM xgw_usage WHERE service_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .bind(serviceId, Math.min(Math.max(1, limit), 1000))
    .all<UsageRow>();
  return results ?? [];
}

// ---------- registry listing (shared entangleit D1) ----------

/**
 * Write (or refresh) the x402market listing for a gateway service.
 *
 * The gateway and the registry share the same D1 and the same operator, so the
 * gateway — which is the source of truth for its own routes and payTo — writes
 * the verified listing directly instead of asking the registry to fetch its
 * manifest from inside the same request chain.
 */
export async function upsertRegistryListing(
  database: D1Like,
  row: ServiceRow,
  opts: { manifestUrl: string; baseUrl: string; toolBase?: string },
): Promise<string> {
  const routes = routesOf(row);
  const paid = routes.filter((r) => r.priceSats > 0);
  // Tool paths must be reachable from the registry's own workers (cross-zone):
  // the workers.dev origin, never an entangleit.com path.
  const toolBase = (opts.toolBase || opts.baseUrl).replace(/\/$/, "");
  const tools = routes.map((r) => ({
    name: r.name,
    method: r.method,
    path: `${toolBase}/g/${row.slug}/${r.name}`,
    priceSats: r.priceSats,
    paid: r.priceSats > 0,
    description: r.description,
  }));
  const minPrice = paid.length ? Math.min(...paid.map((r) => r.priceSats)) : null;
  const existing = await database
    .prepare("SELECT id FROM xm_services WHERE manifest_url = ?")
    .bind(opts.manifestUrl)
    .first<{ id: string }>();
  const id = existing?.id ?? newId("s");
  const t = nowIso();
  if (existing) {
    await database
      .prepare(
        `UPDATE xm_services SET name = ?, tagline = ?, description = ?, base_url = ?, network = 'bsv:mainnet',
           pay_to = ?, owner_contact = ?, status = 'verified', tools_json = ?, tool_count = ?, paid_count = ?,
           free_count = ?, min_price_sats = ?, last_checked_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        row.name,
        row.tagline,
        row.description,
        opts.baseUrl,
        row.pay_to,
        row.owner_contact,
        JSON.stringify(tools),
        tools.length,
        paid.length,
        tools.length - paid.length,
        minPrice,
        t,
        t,
        id,
      )
      .run();
  } else {
    await database
      .prepare(
        `INSERT INTO xm_services (id, name, tagline, description, manifest_url, base_url, network, pay_to, owner_contact, status, tools_json, tool_count, paid_count, free_count, min_price_sats, last_checked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'bsv:mainnet', ?, ?, 'verified', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        row.name,
        row.tagline,
        row.description,
        opts.manifestUrl,
        opts.baseUrl,
        row.pay_to,
        row.owner_contact,
        JSON.stringify(tools),
        tools.length,
        paid.length,
        tools.length - paid.length,
        minPrice,
        t,
        t,
        t,
      )
      .run();
  }
  return id;
}

// ---------- public analytics dashboards ----------

export interface DashboardRow {
  service_id: string;
  token: string;
  revoked: number;
  views: number;
  last_viewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function dashboardToken(): string {
  const rand = crypto.getRandomValues(new Uint8Array(18));
  return `xgw_dash_${[...rand].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function getDashboard(database: D1Like, serviceId: string): Promise<DashboardRow | null> {
  return database.prepare("SELECT * FROM xgw_dashboards WHERE service_id = ?").bind(serviceId).first<DashboardRow>();
}

/** Create or rotate the share token (old links stop working). */
export async function rotateDashboardToken(database: D1Like, serviceId: string): Promise<DashboardRow> {
  const token = dashboardToken();
  const t = nowIso();
  await database
    .prepare(
      `INSERT INTO xgw_dashboards (service_id, token, revoked, views, created_at, updated_at)
       VALUES (?, ?, 0, 0, ?, ?)
       ON CONFLICT(service_id) DO UPDATE SET token = excluded.token, revoked = 0, views = 0, last_viewed_at = NULL, updated_at = excluded.updated_at`,
    )
    .bind(serviceId, token, t, t)
    .run();
  const row = await getDashboard(database, serviceId);
  if (!row) throw new HttpError(500, "Dashboard token insert failed");
  return row;
}

export async function revokeDashboardToken(database: D1Like, serviceId: string): Promise<boolean> {
  const res = (await database
    .prepare("UPDATE xgw_dashboards SET revoked = 1, updated_at = ? WHERE service_id = ?")
    .bind(nowIso(), serviceId)
    .run()) as { meta?: { changes?: number } };
  return (res.meta?.changes ?? 0) === 1;
}

/** Resolve an active (non-revoked) token to its service id. */
export async function resolveDashboardToken(database: D1Like, token: string): Promise<string | null> {
  const row = await database
    .prepare("SELECT service_id FROM xgw_dashboards WHERE token = ? AND revoked = 0")
    .bind(token)
    .first<{ service_id: string }>();
  return row?.service_id ?? null;
}

export async function touchDashboard(database: D1Like, token: string): Promise<void> {
  await database
    .prepare("UPDATE xgw_dashboards SET views = views + 1, last_viewed_at = ? WHERE token = ?")
    .bind(nowIso(), token)
    .run();
}
