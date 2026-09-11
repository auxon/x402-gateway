-- x402-gateway tables live in the SHARED entangleit D1 (consolidated 2026-09-10).
-- All tables are xgw_-prefixed to avoid collisions.
-- Apply: wrangler d1 execute entangleit --file=schema.sql --remote   (from the repo root)

CREATE TABLE IF NOT EXISTS xgw_services (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL,
  auth_header TEXT NOT NULL DEFAULT '',
  auth_value TEXT NOT NULL DEFAULT '',
  pay_to TEXT NOT NULL,
  owner_contact TEXT NOT NULL DEFAULT '',
  admin_key_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  routes_json TEXT NOT NULL DEFAULT '[]',
  registry_id TEXT NOT NULL DEFAULT '',
  total_calls INTEGER NOT NULL DEFAULT 0,
  total_sats INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xgw_services_status ON xgw_services(status, created_at DESC);

CREATE TABLE IF NOT EXISTS xgw_usage (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES xgw_services(id) ON DELETE CASCADE,
  route TEXT NOT NULL DEFAULT '',
  payer TEXT NOT NULL DEFAULT '',
  sats INTEGER NOT NULL DEFAULT 0,
  txid TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xgw_usage_service ON xgw_usage(service_id, created_at DESC);

-- Hosting tiers: a service is Free until its owner subscribes to Pro via Stripe.
-- Kept separate so the schema stays additive.
CREATE TABLE IF NOT EXISTS xgw_subscriptions (
  service_id TEXT PRIMARY KEY REFERENCES xgw_services(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'none',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xgw_subscriptions_sub ON xgw_subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_xgw_subscriptions_customer ON xgw_subscriptions(stripe_customer_id);

-- Stripe webhook idempotency (events can be retried).
CREATE TABLE IF NOT EXISTS xgw_stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Public analytics dashboards: one revocable share token per service. Owners
-- (admin key) create/rotate it; anyone with the token can view the analytics
-- for that service without the admin key. Pro services expose the full call
-- log; Free services expose aggregates only.
CREATE TABLE IF NOT EXISTS xgw_dashboards (
  service_id TEXT PRIMARY KEY REFERENCES xgw_services(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xgw_dashboards_token ON xgw_dashboards(token);

-- Gateway Watch: uptime + 402-validity monitoring for paid endpoints.
-- Watches belong to gateway services (admin-key auth) and ride the service's
-- Pro subscription: Free gets 1 watch with daily checks and no alerts, Pro
-- gets up to 10 watches with 15-minute checks, email + webhook alerts, and a
-- public status page. Kept separate so the schema stays additive.
CREATE TABLE IF NOT EXISTS xgw_watches (
  id TEXT PRIMARY KEY,
  service_id TEXT REFERENCES xgw_services(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  target_url TEXT NOT NULL,
  expect_402 INTEGER NOT NULL DEFAULT 1,
  webhook_url TEXT NOT NULL DEFAULT '',
  alert_email INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'ok', 'failing', 'paused')),
  paused INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_latency_ms INTEGER,
  last_price_sats INTEGER,
  last_pay_to TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  last_checked_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  alerted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xgw_watches_service ON xgw_watches(service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_xgw_watches_due ON xgw_watches(paused, last_checked_at);

-- Bounded per-watch check history (pruned by the cron runner).
CREATE TABLE IF NOT EXISTS xgw_watch_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id TEXT NOT NULL REFERENCES xgw_watches(id) ON DELETE CASCADE,
  ok INTEGER NOT NULL,
  status INTEGER,
  latency_ms INTEGER,
  price_sats INTEGER,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xgw_watch_checks_watch ON xgw_watch_checks(watch_id, created_at DESC);

-- Annual billing lives on the same subscription row as monthly Pro.
-- NULL means monthly (pre-interval rows and events without metadata).
ALTER TABLE xgw_subscriptions ADD COLUMN billing_interval TEXT;
-- Credential encryption (GATEWAY_CREDS_KEY, AES-GCM envelope). Pre-key rows
-- keep plaintext auth_value and migrate on next admin write.
ALTER TABLE xgw_services ADD COLUMN auth_value_enc TEXT;
-- Trust-discount accounting per settled call.
ALTER TABLE xgw_usage ADD COLUMN discount_sats INTEGER NOT NULL DEFAULT 0;
