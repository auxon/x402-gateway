/**
 * Service analytics for the dashboard.
 *
 * Free services expose aggregates only (totals); Pro adds the per-day series,
 * the per-route breakdown, and the recent call log. The same builder serves the
 * owner view (admin key) and public share links (dashboard token).
 */
import type { PlanState } from "./plans.ts";
import type { ServiceRow } from "./store.ts";

export interface ServiceAnalytics {
  service: { id: string; slug: string; name: string; plan: "free" | "pro" };
  pro: boolean;
  generatedAt: string;
  windowDays: number;
  totals: {
    calls: number;
    sats: number;
    paidCalls: number;
    freeCalls: number;
    errors: number;
    successRate: number | null;
  };
  byDay: { day: string; calls: number; sats: number }[];
  byRoute: { route: string; calls: number; sats: number; errors: number; avgMs: number }[];
  recent: {
    createdAt: string;
    route: string;
    payer: string;
    sats: number;
    txid: string;
    status: number;
    ms: number;
  }[];
}

interface D1Stmt {
  bind(...params: unknown[]): D1Stmt;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface D1Like {
  prepare(query: string): D1Stmt;
}

const DAY_MS = 86_400_000;

export function clampDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(90, Math.max(1, Math.round(n)));
}

function sinceIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

export async function buildAnalytics(
  database: D1Like,
  row: ServiceRow,
  plan: PlanState,
  days: number,
): Promise<ServiceAnalytics> {
  const since = sinceIso(days);
  const pro = plan.limits.usageLog;

  const totalsRow = await database
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(sats), 0) AS sats,
              COALESCE(SUM(CASE WHEN sats > 0 THEN 1 ELSE 0 END), 0) AS paid_calls,
              COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
       FROM xgw_usage WHERE service_id = ? AND created_at >= ?`,
    )
    .bind(row.id, since)
    .first<{ calls: number; sats: number; paid_calls: number; errors: number }>();

  const calls = Number(totalsRow?.calls ?? 0);
  const sats = Number(totalsRow?.sats ?? 0);
  const paidCalls = Number(totalsRow?.paid_calls ?? 0);
  const errors = Number(totalsRow?.errors ?? 0);

  const analytics: ServiceAnalytics = {
    service: { id: row.id, slug: row.slug, name: row.name, plan: plan.id },
    pro,
    generatedAt: new Date().toISOString(),
    windowDays: days,
    totals: {
      calls,
      sats,
      paidCalls,
      freeCalls: calls - paidCalls,
      errors,
      successRate: calls > 0 ? Math.round(((calls - errors) / calls) * 1000) / 10 : null,
    },
    byDay: [],
    byRoute: [],
    recent: [],
  };

  if (!pro) return analytics;

  const dayRows = await database
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS calls, COALESCE(SUM(sats), 0) AS sats
       FROM xgw_usage WHERE service_id = ? AND created_at >= ?
       GROUP BY day ORDER BY day ASC LIMIT 120`,
    )
    .bind(row.id, since)
    .all<{ day: string; calls: number; sats: number }>();
  analytics.byDay = (dayRows.results ?? []).map((r) => ({ day: r.day, calls: Number(r.calls), sats: Number(r.sats) }));

  const routeRows = await database
    .prepare(
      `SELECT route, COUNT(*) AS calls, COALESCE(SUM(sats), 0) AS sats,
              COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
              CAST(AVG(ms) AS INTEGER) AS avg_ms
       FROM xgw_usage WHERE service_id = ? AND created_at >= ?
       GROUP BY route ORDER BY calls DESC, sats DESC LIMIT 100`,
    )
    .bind(row.id, since)
    .all<{ route: string; calls: number; sats: number; errors: number; avg_ms: number }>();
  analytics.byRoute = (routeRows.results ?? []).map((r) => ({
    route: r.route,
    calls: Number(r.calls),
    sats: Number(r.sats),
    errors: Number(r.errors),
    avgMs: Number(r.avg_ms ?? 0),
  }));

  const recentRows = await database
    .prepare(
      `SELECT created_at, route, payer, sats, txid, status, ms
       FROM xgw_usage WHERE service_id = ? AND created_at >= ?
       ORDER BY created_at DESC, rowid DESC LIMIT 50`,
    )
    .bind(row.id, since)
    .all<{ created_at: string; route: string; payer: string; sats: number; txid: string; status: number; ms: number }>();
  analytics.recent = (recentRows.results ?? []).map((r) => ({
    createdAt: r.created_at,
    route: r.route,
    payer: r.payer,
    sats: Number(r.sats),
    txid: r.txid,
    status: Number(r.status),
    ms: Number(r.ms),
  }));

  return analytics;
}
