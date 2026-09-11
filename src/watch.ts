/**
 * Gateway Watch: monitor paid endpoints the way a buyer would.
 *
 * Each watch probes one URL on a schedule and records what a buyer would see:
 * liveness, the 402 challenge (price + payTo + network), and latency. Price or
 * payTo changes against the observed baseline raise their own warning — a
 * changed challenge is either an edit or a hijack, and the owner decides.
 *
 * Watches belong to gateway services (admin-key auth) and ride the service's
 * Pro subscription: Free gets 1 watch with daily checks and no alerts, Pro
 * gets up to 10 watches with 15-minute checks, email + webhook alerts, and a
 * public status page. Paid routes are auto-watched on registration.
 */
import { b64decodeJson, type Env } from "./x402.ts";
import { HttpError, cleanStr, isPrivateHost, newId, nowIso } from "./store.ts";
import { subscriptionIsActive } from "./plans.ts";

export interface WatchRow {
  id: string;
  service_id: string | null;
  label: string;
  target_url: string;
  expect_402: number;
  webhook_url: string;
  alert_email: number;
  status: "unknown" | "ok" | "failing" | "paused";
  paused: number;
  last_status: number | null;
  last_latency_ms: number | null;
  last_price_sats: number | null;
  last_pay_to: string;
  last_error: string;
  last_checked_at: string | null;
  consecutive_failures: number;
  alerted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WatchCheckRow {
  id: number;
  watch_id: string;
  ok: number;
  status: number | null;
  latency_ms: number | null;
  price_sats: number | null;
  error: string;
  created_at: string;
}

export const WATCH_FREE_MAX = 1;
export const WATCH_PRO_MAX = 10;

function num(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function watchIntervals(env: Env): { freeMin: number; proMin: number } {
  return {
    freeMin: num(env, "WATCH_FREE_INTERVAL_MIN", 1440),
    proMin: num(env, "WATCH_PRO_INTERVAL_MIN", 15),
  };
}

export function watchHistoryDays(env: Env, pro: boolean): number {
  return pro
    ? num(env, "WATCH_PRO_HISTORY_DAYS", 90)
    : num(env, "WATCH_FREE_HISTORY_DAYS", 7);
}

export function watchMaxPerRun(env: Env): number {
  return Math.min(Math.max(num(env, "WATCH_MAX_PER_RUN", 50), 1), 500);
}

export function watchCheckTimeoutMs(env: Env): number {
  return Math.min(Math.max(num(env, "WATCH_CHECK_TIMEOUT_MS", 10_000), 1000), 60_000);
}

// ---------- validation ----------

/** Watch targets may carry a query string (unlike registered base URLs). */
export function validateWatchUrl(value: unknown): string {
  const raw = cleanStr(value, 500);
  if (!raw) throw new HttpError(400, "url is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "url must be a valid https:// URL");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "url must use https://");
  if (url.username || url.password) throw new HttpError(400, "url must not contain credentials");
  if (isPrivateHost(url)) throw new HttpError(400, "url points to a private or local host");
  url.hash = "";
  return url.toString();
}

export function validateWebhookUrl(value: unknown): string {
  const raw = cleanStr(value, 500);
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "webhookUrl must be a valid https:// URL");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "webhookUrl must use https://");
  if (url.username || url.password) throw new HttpError(400, "webhookUrl must not contain credentials");
  if (isPrivateHost(url)) throw new HttpError(400, "webhookUrl points to a private or local host");
  return url.toString();
}

/** `{"route": "forecast"}` watches the service's own proxy URL (workers.dev, never same-zone). */
export function resolveWatchTarget(
  input: { url?: unknown; route?: unknown },
  service: { slug: string },
  workersDevBase: string,
): string {
  const route = cleanStr(input.route, 40).toLowerCase();
  if (route) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(route)) {
      throw new HttpError(400, "route must be a valid route name");
    }
    return `${workersDevBase.replace(/\/$/, "")}/g/${service.slug}/${route}`;
  }
  return validateWatchUrl(input.url);
}

// ---------- CRUD ----------

interface D1StmtLike {
  bind(...params: unknown[]): D1StmtLike;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
interface D1Like {
  prepare(query: string): D1StmtLike;
}

export async function createWatch(
  db: D1Like,
  input: {
    serviceId: string;
    label: string;
    targetUrl: string;
    expect402: boolean;
    webhookUrl: string;
  },
): Promise<WatchRow> {
  const id = newId("xww");
  const t = nowIso();
  await db
    .prepare(
      `INSERT INTO xgw_watches (id, service_id, label, target_url, expect_402, webhook_url, alert_email, status, paused, consecutive_failures, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'unknown', 0, 0, ?, ?)`,
    )
    .bind(id, input.serviceId, input.label, input.targetUrl, input.expect402 ? 1 : 0, input.webhookUrl, t, t)
    .run();
  const row = await db.prepare("SELECT * FROM xgw_watches WHERE id = ?").bind(id).first<WatchRow>();
  if (!row) throw new HttpError(500, "Watch insert failed");
  return row;
}

export async function getWatch(db: D1Like, id: string): Promise<WatchRow | null> {
  return db.prepare("SELECT * FROM xgw_watches WHERE id = ?").bind(id).first<WatchRow>();
}

export async function getWatchForService(
  db: D1Like,
  serviceId: string,
  id: string,
): Promise<WatchRow | null> {
  const row = await getWatch(db, id);
  return row && row.service_id === serviceId ? row : null;
}

export async function listWatches(db: D1Like, serviceId: string): Promise<WatchRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM xgw_watches WHERE service_id = ? ORDER BY created_at ASC")
    .bind(serviceId)
    .all<WatchRow>();
  return results ?? [];
}

export async function countWatches(db: D1Like, serviceId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM xgw_watches WHERE service_id = ?")
    .bind(serviceId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export function watchQuota(pro: boolean): number {
  return pro ? WATCH_PRO_MAX : WATCH_FREE_MAX;
}

export async function updateWatch(
  db: D1Like,
  id: string,
  patch: { label?: string; webhookUrl?: string; expect402?: boolean; paused?: boolean },
): Promise<WatchRow> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.label !== undefined) {
    fields.push("label = ?");
    values.push(cleanStr(patch.label, 120));
  }
  if (patch.webhookUrl !== undefined) {
    fields.push("webhook_url = ?");
    values.push(validateWebhookUrl(patch.webhookUrl));
  }
  if (patch.expect402 !== undefined) {
    fields.push("expect_402 = ?");
    values.push(patch.expect402 ? 1 : 0);
  }
  if (patch.paused !== undefined) {
    fields.push("paused = ?");
    values.push(patch.paused ? 1 : 0);
  }
  if (fields.length === 0) {
    const row = await getWatch(db, id);
    if (!row) throw new HttpError(404, "Watch not found");
    return row;
  }
  fields.push("updated_at = ?");
  values.push(nowIso(), id);
  await db.prepare(`UPDATE xgw_watches SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  const row = await getWatch(db, id);
  if (!row) throw new HttpError(404, "Watch not found");
  return row;
}

export async function deleteWatch(db: D1Like, id: string): Promise<void> {
  await db.prepare("DELETE FROM xgw_watch_checks WHERE watch_id = ?").bind(id).run();
  await db.prepare("DELETE FROM xgw_watches WHERE id = ?").bind(id).run();
}

export async function deleteWatchesForService(db: D1Like, serviceId: string): Promise<void> {
  await db
    .prepare("DELETE FROM xgw_watch_checks WHERE watch_id IN (SELECT id FROM xgw_watches WHERE service_id = ?)")
    .bind(serviceId)
    .run();
  await db.prepare("DELETE FROM xgw_watches WHERE service_id = ?").bind(serviceId).run();
}

export function publicWatch(row: WatchRow, statusUrl: string | null = null) {
  return {
    id: row.id,
    label: row.label,
    targetUrl: row.target_url,
    expect402: row.expect_402 === 1,
    status: row.paused === 1 ? "paused" : row.status,
    lastStatus: row.last_status,
    lastLatencyMs: row.last_latency_ms,
    lastPriceSats: row.last_price_sats,
    lastPayTo: row.last_pay_to || null,
    lastError: row.last_error || null,
    lastCheckedAt: row.last_checked_at,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    ...(statusUrl ? { statusUrl } : {}),
  };
}

// ---------- probe ----------

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  priceSats: number | null;
  payTo: string | null;
  error: string | null;
}

function fail(status: number | null, latencyMs: number | null, error: string): ProbeResult {
  return { ok: false, status, latencyMs, priceSats: null, payTo: null, error };
}

/**
 * Parse a target that points at this gateway's own proxy routes
 * (`<workers-dev>/g/<slug>/<tool>`). Self-fetches 522 at the edge, so
 * own routes are evaluated in-process instead (same decision code as the
 * proxy's pre-payment path).
 */
export function parseSelfRoute(
  targetUrl: string,
  workersDevBase: string,
): { slug: string; tool: string } | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  let base: URL;
  try {
    base = new URL(workersDevBase);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  const match = url.pathname.match(/^\/g\/([a-z0-9][a-z0-9-]{0,39})\/([a-z0-9][a-z0-9-]{0,39})\/?$/);
  if (!match) return null;
  return { slug: match[1], tool: match[2] };
}

export interface LocalService {
  slug: string;
  status: string;
  pay_to: string;
  routesJson: string;
}

/** Evaluate an own-route watch without network: same rules as the proxy. */
export function evaluateLocalRoute(
  service: LocalService,
  tool: string,
  expect402: boolean,
): ProbeResult {
  const started = Date.now();
  if (service.status !== "active") {
    return fail(404, Date.now() - started, "service_paused");
  }
  let routes: { name?: unknown; priceSats?: unknown }[] = [];
  try {
    const parsed = JSON.parse(service.routesJson) as unknown;
    if (Array.isArray(parsed)) routes = parsed;
  } catch {
    return fail(500, Date.now() - started, "routes_unreadable");
  }
  const route = routes.find((r) => r.name === tool);
  if (!route) return fail(404, Date.now() - started, "tool_not_found");
  const price = Number(route.priceSats ?? 0);
  if (!Number.isInteger(price) || price < 0) {
    return fail(500, Date.now() - started, "route_mispriced");
  }
  if (price === 0) {
    return expect402
      ? fail(200, Date.now() - started, "expected_402")
      : { ok: true, status: 200, latencyMs: Date.now() - started, priceSats: 0, payTo: "", error: null };
  }
  return {
    ok: true,
    status: 402,
    latencyMs: Date.now() - started,
    priceSats: price,
    payTo: service.pay_to,
    error: null,
  };
}

/**
 * Fetch a URL the way a buyer would: unsigned GET, no redirect following.
 * `fetchFn` is injectable so tests never touch the network.
 */
export async function probeTarget(
  targetUrl: string,
  expect402: boolean,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<ProbeResult> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchFn(targetUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "x402-gateway-watch/1 (+https://entangleit.com/x402gateway)",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    const reason = /abort|timeout/i.test(message) ? "timeout" : `unreachable: ${message.slice(0, 120)}`;
    return fail(null, Date.now() - started, reason);
  }
  const latencyMs = Date.now() - started;
  if (res.status >= 300 && res.status < 400) {
    return fail(res.status, latencyMs, "redirect_blocked");
  }
  if (res.status === 200) {
    return expect402
      ? fail(200, latencyMs, "expected_402")
      : { ok: true, status: 200, latencyMs, priceSats: 0, payTo: "", error: null };
  }
  if (res.status === 402) {
    const header = res.headers.get("PAYMENT-REQUIRED");
    if (!header) return fail(402, latencyMs, "402_without_challenge");
    let req: unknown;
    try {
      req = b64decodeJson(header);
    } catch {
      return fail(402, latencyMs, "challenge_unparseable");
    }
    if (!req || typeof req !== "object") return fail(402, latencyMs, "challenge_unparseable");
    const rec = req as Record<string, unknown>;
    const price = Number(rec.amount ?? rec.satoshis);
    const payTo = String(rec.payTo ?? "");
    const network = String(rec.network ?? "");
    if (!Number.isInteger(price) || price < 0 || !payTo || !network) {
      return fail(402, latencyMs, "challenge_incomplete");
    }
    return { ok: true, status: 402, latencyMs, priceSats: price, payTo, error: null };
  }
  return fail(res.status, latencyMs, `http_${res.status}`);
}

// ---------- check runner ----------

export interface CheckOutcome {
  watch: WatchRow;
  probe: ProbeResult;
  /** State change worth alerting on (transitions only — no repeat alerts). */
  transition: "down" | "recovered" | null;
  /** Challenge terms moved against the observed baseline. */
  termsChanged: boolean;
}

export async function runCheck(
  db: D1Like,
  watch: WatchRow,
  opts: {
    timeoutMs?: number;
    historyDays?: number;
    fetchFn?: typeof fetch;
    workersDevBase?: string;
  } = {},
): Promise<CheckOutcome> {
  let probe: ProbeResult;
  const self = opts.workersDevBase ? parseSelfRoute(watch.target_url, opts.workersDevBase) : null;
  if (self) {
    const svc = await db
      .prepare("SELECT slug, status, pay_to, routes_json FROM xgw_services WHERE slug = ?")
      .bind(self.slug)
      .first<{ slug: string; status: string; pay_to: string; routes_json: string }>();
    probe = svc
      ? evaluateLocalRoute(
          { slug: svc.slug, status: svc.status, pay_to: svc.pay_to, routesJson: svc.routes_json },
          self.tool,
          watch.expect_402 === 1,
        )
      : fail(404, 0, "service_not_found");
  } else {
    probe = await probeTarget(
      watch.target_url,
      watch.expect_402 === 1,
      opts.timeoutMs ?? 10_000,
      opts.fetchFn,
    );
  }
  const prev = watch.status;
  const next = probe.ok ? "ok" : "failing";
  const baselinePrice = watch.last_price_sats;
  const baselinePayTo = watch.last_pay_to;
  const termsChanged =
    probe.ok &&
    baselinePrice !== null &&
    probe.priceSats !== null &&
    (probe.priceSats !== baselinePrice || (probe.payTo ?? "") !== (baselinePayTo ?? ""));

  const t = nowIso();
  await db
    .prepare(
      `UPDATE xgw_watches SET status = ?, last_status = ?, last_latency_ms = ?, last_price_sats = ?,
        last_pay_to = ?, last_error = ?, last_checked_at = ?,
        consecutive_failures = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      next,
      probe.status,
      probe.latencyMs,
      probe.priceSats,
      probe.payTo ?? "",
      probe.error ?? "",
      t,
      probe.ok ? 0 : watch.consecutive_failures + 1,
      t,
      watch.id,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO xgw_watch_checks (watch_id, ok, status, latency_ms, price_sats, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(watch.id, probe.ok ? 1 : 0, probe.status, probe.latencyMs, probe.priceSats, probe.error ?? "", t)
    .run();
  await pruneChecks(db, watch.id, opts.historyDays ?? 90);

  const fresh = (await getWatch(db, watch.id)) ?? { ...watch, status: next } as WatchRow;
  const transition: CheckOutcome["transition"] =
    prev !== next && next === "failing" ? "down" : prev === "failing" && next === "ok" ? "recovered" : null;
  return { watch: fresh, probe, transition, termsChanged };
}

export async function pruneChecks(db: D1Like, watchId: string, keepDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  await db
    .prepare("DELETE FROM xgw_watch_checks WHERE watch_id = ? AND created_at < ?")
    .bind(watchId, cutoff)
    .run();
}

export interface DueWatch {
  watch: WatchRow;
  pro: boolean;
}
export async function dueWatches(
  db: D1Like,
  opts: { now?: number; limit?: number; freeIntervalMin?: number; proIntervalMin?: number } = {},
): Promise<DueWatch[]> {
  const now = opts.now ?? Date.now();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const { results } = await db
    .prepare(
      `SELECT w.*, sub.status AS sub_status, sub.current_period_end AS sub_period_end
       FROM xgw_watches w
       JOIN xgw_services s ON s.id = w.service_id
       LEFT JOIN xgw_subscriptions sub ON sub.service_id = w.service_id
       WHERE w.paused = 0 AND s.status = 'active'
       ORDER BY w.last_checked_at ASC NULLS FIRST LIMIT ?`,
    )
    .bind(limit)
    .all<WatchRow & { sub_status: string | null; sub_period_end: string | null }>();
  const freeMs = (opts.freeIntervalMin ?? 1440) * 60_000;
  const proMs = (opts.proIntervalMin ?? 15) * 60_000;
  const due: DueWatch[] = [];
  for (const row of results ?? []) {
    const pro = subscriptionIsActive(row.sub_status, row.sub_period_end, now);
    const interval = pro ? proMs : freeMs;
    const last = row.last_checked_at ? Date.parse(row.last_checked_at) : NaN;
    if (Number.isNaN(last) || now - last >= interval) due.push({ watch: row, pro });
  }
  return due;
}

// ---------- alerts ----------

export type WatchAlertType = "watch.down" | "watch.recovered" | "watch.terms_changed";

export async function sendWatchAlert(
  db: D1Like,
  env: Env,
  watch: WatchRow,
  service: { slug: string; name: string; owner_contact: string } | null,
  event: {
    type: WatchAlertType;
    probe: ProbeResult;
    statusUrl: string;
  },
): Promise<{ email: boolean; webhook: boolean }> {
  const label = watch.label || watch.target_url;
  const titles: Record<WatchAlertType, string> = {
    "watch.down": `DOWN: ${label}`,
    "watch.recovered": `RECOVERED: ${label}`,
    "watch.terms_changed": `Challenge changed: ${label}`,
  };
  const title = titles[event.type];
  const lines = [
    `Service: ${service ? `${service.name} (${service.slug})` : "(external URL)"}`,
    `Target: ${watch.target_url}`,
    `HTTP: ${event.probe.status ?? "—"} · latency: ${event.probe.latencyMs ?? "—"} ms`,
    event.probe.priceSats !== null && event.probe.priceSats !== undefined
      ? `Challenge: ${event.probe.priceSats} sats → ${event.probe.payTo || "?"}`
      : null,
    event.probe.error ? `Error: ${event.probe.error}` : null,
    `Checked: ${watch.last_checked_at ?? "just now"}`,
    `Status: ${event.statusUrl}`,
  ].filter((l): l is string => l !== null);
  const text = lines.join("\n");

  let webhook = false;
  if (watch.webhook_url) {
    try {
      const res = await fetch(watch.webhook_url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "x402-gateway-watch/1" },
        body: JSON.stringify({
          event: event.type,
          watchId: watch.id,
          serviceId: watch.service_id,
          serviceSlug: service?.slug ?? null,
          label: watch.label,
          targetUrl: watch.target_url,
          status: watch.status,
          httpStatus: event.probe.status,
          latencyMs: event.probe.latencyMs,
          priceSats: event.probe.priceSats,
          payTo: event.probe.payTo,
          error: event.probe.error,
          checkedAt: watch.last_checked_at,
          statusUrl: event.statusUrl,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      webhook = res.ok;
    } catch (e) {
      console.error("[watch-alert] webhook failed", watch.id, String((e as Error)?.message ?? e).slice(0, 160));
    }
  }

  let email = false;
  const to = service && /@/.test(service.owner_contact) ? service.owner_contact : "";
  const key = env.RESEND_API_KEY;
  if (to && key) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: env.WATCH_ALERT_FROM ?? "x402 Gateway <alerts@entangleit.com>",
          to: [to],
          subject: `[Watch] ${title}`,
          text,
        }),
      });
      email = res.ok;
    } catch (e) {
      console.error("[watch-alert] email failed", watch.id, String((e as Error)?.message ?? e).slice(0, 160));
    }
  }

  await markAlerted(db, watch.id).catch(() => undefined);
  return { email, webhook };
}

async function markAlerted(db: D1Like, watchId: string): Promise<void> {
  const t = nowIso();
  await db
    .prepare("UPDATE xgw_watches SET alerted_at = ?, updated_at = ? WHERE id = ?")
    .bind(t, t, watchId)
    .run();
}

// ---------- public status ----------

export interface WatchStatus {
  watch: ReturnType<typeof publicWatch>;
  uptimePct: number | null;
  totalChecks: number;
  okChecks: number;
  recent: {
    ok: boolean;
    status: number | null;
    latencyMs: number | null;
    priceSats: number | null;
    error: string | null;
    createdAt: string;
  }[];
}

export async function watchStatus(
  db: D1Like,
  watchId: string,
  statusUrl: string,
  days = 30,
): Promise<WatchStatus | null> {
  const row = await getWatch(db, watchId);
  if (!row || row.paused === 1) return null;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const agg = await db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS ok FROM xgw_watch_checks WHERE watch_id = ? AND created_at >= ?",
    )
    .bind(watchId, since)
    .first<{ n: number; ok: number }>();
  const { results } = await db
    .prepare(
      "SELECT ok, status, latency_ms, price_sats, error, created_at FROM xgw_watch_checks WHERE watch_id = ? ORDER BY created_at DESC, id DESC LIMIT 20",
    )
    .bind(watchId)
    .all<{ ok: number; status: number | null; latency_ms: number | null; price_sats: number | null; error: string; created_at: string }>();
  const total = Number(agg?.n ?? 0);
  const okCount = Number(agg?.ok ?? 0);
  return {
    watch: publicWatch(row, statusUrl),
    uptimePct: total > 0 ? Math.round((okCount / total) * 1000) / 10 : null,
    totalChecks: total,
    okChecks: okCount,
    recent: (results ?? []).map((r) => ({
      ok: r.ok === 1,
      status: r.status,
      latencyMs: r.latency_ms,
      priceSats: r.price_sats,
      error: r.error || null,
      createdAt: r.created_at,
    })),
  };
}

export function watchStatusHtml(base: string, data: WatchStatus): string {
  const w = data.watch;
  const dot = w.status === "ok" ? "#6ee7b7" : w.status === "failing" ? "#f87171" : "#8b97ab";
  const rows = data.recent
    .map(
      (r) =>
        `<tr><td class="mono">${r.createdAt.replace("T", " ").slice(0, 19)}Z</td>` +
        `<td>${r.ok ? '<span class="ok">ok</span>' : '<span class="err">fail</span>'}</td>` +
        `<td class="num">${r.status ?? "—"}</td><td class="num">${r.latencyMs ?? "—"}</td>` +
        `<td class="num">${r.priceSats ?? "—"}</td><td>${r.error ? `<span class="err">${r.error}</span>` : "—"}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watch status — ${w.label || w.targetUrl} · x402 Gateway</title>
<meta name="description" content="Uptime and 402-challenge status for ${w.targetUrl}, monitored by x402 Gateway Watch.">
<link rel="canonical" href="${base}/watch/${w.id}">
<meta name="robots" content="noindex,nofollow">
<style>
  :root { --bg:#0b0e14; --panel:#121722; --line:#232c3d; --text:#e8edf5; --muted:#8b97ab; --accent:#6ee7b7; --accent2:#38bdf8; --danger:#f87171; }
  * { box-sizing:border-box; }
  body { margin:0; background:radial-gradient(1200px 600px at 20% -10%, #16233a 0%, var(--bg) 55%); color:var(--text); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:860px; margin:0 auto; padding:32px 20px 70px; }
  a { color:var(--accent2); text-decoration:none; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px; }
  .ok { color:var(--accent); font-weight:600; } .err { color:var(--danger); font-weight:600; } .muted { color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th,td { text-align:left; padding:7px 9px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
  td.num, th.num { text-align:right; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
</style></head>
<body><div class="wrap">
  <p><a href="${base}/">← x402 Gateway</a></p>
  <h1><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${dot};margin-right:10px"></span>${w.label || "Watched endpoint"}</h1>
  <p class="muted mono">${w.targetUrl}</p>
  <div class="panel">
    <strong>${w.status.toUpperCase()}</strong>
    <span class="muted"> · uptime ${data.uptimePct === null ? "—" : `${data.uptimePct}%`} (${data.okChecks}/${data.totalChecks} checks, 30d)</span>
    ${w.lastError ? `<div class="err" style="margin-top:8px">${w.lastError}</div>` : ""}
  </div>
  <h2 style="font-size:15px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:26px 0 10px">Recent checks</h2>
  <div class="panel" style="overflow-x:auto"><table>
    <tr><th>Checked</th><th>Result</th><th class="num">HTTP</th><th class="num">ms</th><th class="num">sats</th><th>Error</th></tr>
    ${rows || '<tr><td colspan="6" class="muted">No checks yet.</td></tr>'}
  </table></div>
  <p class="muted" style="font-size:13px">Monitored by <a href="${base}/">x402 Gateway Watch</a> — uptime and 402-challenge checks for paid endpoints.</p>
</div>
</body></html>`;
}

// ---------- cron ----------

export interface CronResult {
  checked: number;
  alerted: number;
  errors: number;
}

/**
 * Check every due watch and alert on transitions. Designed for a 15-minute
 * cron tick: due selection is plan-aware (Pro every 15 min, Free daily),
 * checks run in small batches, and a global prune keeps history bounded even
 * for watches that never run (paused).
 */
export async function runWatchCron(
  env: Env,
  opts: { publicBase: string; fetchFn?: typeof fetch } = { publicBase: "" },
): Promise<CronResult> {
  const database = (env.DB as D1Like);
  const { freeMin, proMin } = watchIntervals(env);
  const due = await dueWatches(database, {
    limit: watchMaxPerRun(env),
    freeIntervalMin: freeMin,
    proIntervalMin: proMin,
  });
  let checked = 0;
  let alerted = 0;
  let errors = 0;
  const batch = 5;
  const workersDevBase = (env.WORKERS_DEV_BASE || "").replace(/\/$/, "");
  for (let i = 0; i < due.length; i += batch) {
    await Promise.all(
      due.slice(i, i + batch).map(async ({ watch, pro }) => {
        try {
          const outcome = await runCheck(database, watch, {
            timeoutMs: watchCheckTimeoutMs(env),
            historyDays: watchHistoryDays(env, pro),
            fetchFn: opts.fetchFn,
            workersDevBase: workersDevBase || undefined,
          });
          checked += 1;
          if ((outcome.transition || outcome.termsChanged) && pro && watch.paused !== 1) {
            const svc = watch.service_id
              ? await database
                  .prepare("SELECT slug, name, owner_contact FROM xgw_services WHERE id = ?")
                  .bind(watch.service_id)
                  .first<{ slug: string; name: string; owner_contact: string }>()
              : null;
            const sent = await sendWatchAlert(database, env, outcome.watch, svc, {
              type:
                outcome.transition === "recovered"
                  ? "watch.recovered"
                  : outcome.transition === "down"
                    ? "watch.down"
                    : "watch.terms_changed",
              probe: outcome.probe,
              statusUrl: `${opts.publicBase}/watch/${watch.id}`,
            });
            if (sent.email || sent.webhook) alerted += 1;
          }
        } catch (e) {
          errors += 1;
          console.error("[watch-cron]", watch.id, e);
        }
      }),
    );
  }
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  await database
    .prepare("DELETE FROM xgw_watch_checks WHERE created_at < ?")
    .bind(cutoff)
    .run()
    .catch(() => undefined);
  return { checked, alerted, errors };
}
