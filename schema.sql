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
