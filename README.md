# x402 Gateway

Register any upstream API with a price and get a hosted **pay-per-call x402
endpoint** — no Worker to deploy. Buyers pay in BSV sats; the gateway verifies
and broadcasts the payment, then proxies the upstream call with your
credentials injected. Paid services are listed in
[x402market](https://entangleit.com/x402market/) so agents (and agentpay wallets)
can discover and pay them automatically.

Live: **https://entangleit.com/x402gateway** (UI + API) ·
`https://x402-gateway.richard-hein.workers.dev` (proxy origin used by the registry)

```
buyer ──GET /g/<slug>/<tool>────────────► gateway
       ◄─402 + PAYMENT-REQUIRED─────────── (price, your payTo, bsv:mainnet)
       ──retry + PAYMENT-SIGNATURE───────► verify → ARC broadcast → upstream fetch
       ◄─200 + upstream body + receipt──── (PAYMENT-RESPONSE: txid)
```

## Register

From the UI at `/x402gateway`, or:

```bash
curl -s -X POST https://entangleit.com/x402gateway/api/services \
  -H 'content-type: application/json' -d '{
  "name": "Weather Oracle",
  "tagline": "Pay-per-call forecasts",
  "baseUrl": "https://api.weather.example",
  "payTo": "1YourBsvAddress…",
  "ownerContact": "you@example.com",
  "authHeader": "Authorization",
  "authValue": "Bearer sk-…",
  "routes": [
    { "name": "forecast", "method": "GET",  "path": "/v1/forecast", "priceSats": 20, "description": "7-day forecast" },
    { "name": "health",   "method": "GET",  "path": "/healthz",     "priceSats": 0,  "description": "Free probe" }
  ]
}'
```

Response: your gateway base (`/g/<slug>`), the **admin key** (shown once), and
the registry listing id. Paid routes are live immediately.

## Call a paid route

```bash
# 1. unsigned -> 402 + PAYMENT-REQUIRED
curl -si https://entangleit.com/x402gateway/g/weather-oracle/forecast?city=YYZ

# 2. pay with any x402 BSV client, retry with proof
curl -s https://entangleit.com/x402gateway/g/weather-oracle/forecast?city=YYZ \
  -H "PAYMENT-SIGNATURE: <base64 payload>"
# -> upstream JSON + PAYMENT-RESPONSE (txid)
```

Query strings (GET) and JSON bodies (POST, 64KB cap) pass through. Route paths
may contain `{param}` placeholders filled from caller query parameters — e.g.
`/{title}` with `?title=Bitcoin`, or `/{year}/{country}` with
`?year=2026&country=CA`. Consumed parameters are stripped before forwarding.
Upstream responses are capped at 512KB (`X-Gateway-Truncated: 1` when cut) and
time out after 20s. POST bodies are forwarded as received.

Agentpay agents do all of this automatically:

```bash
# discover, quote, settle, and fetch in one MCP/REST call
POST /api/agentpay/agent/pay-service {"serviceId":"s_…","tool":"forecast","params":{"city":"YYZ"}}
```

## Management API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /` | — | Registration UI + service directory |
| `GET /health` | — | Service + count |
| `GET /api/services[?q=]` | — | Active services with routes and totals |
| `GET /api/services/:slug` | — | Detail (never returns credentials) |
| `POST /api/services` | — | Register (5/day per IP) |
| `POST /api/services/:slug/admin` | `X-Admin-Key` | `update` fields/routes, `pause`, `resume`, `relist`, `rotate`, `usage`, `delete` |
| `GET /g/:slug/manifest` | — | Registry manifest (workers.dev origin) |
| `GET/POST /g/:slug/:tool` | x402 | Paid proxy endpoint |

Admin key rotation: `{"action":"rotate"}` returns a new key once; the old one
stops working immediately. Paused services 404 for both the proxy and the
directory.

## Hosting tiers

Every service starts on **Free**; **Pro ($9/mo)** is a Stripe subscription
(`PRO_PRICE_CENTS` overrides the price, `STRIPE_PRICE_GATEWAY_PRO` pins a
pre-created recurring Price). Entitlements come from `xgw_subscriptions`, which
only verified Stripe webhooks write.

| | Free | Pro ($9/mo) |
| --- | --- | --- |
| Routes per service | 5 | 100 |
| Aggregate calls/sats totals | yes | yes |
| Per-call analytics log | — | yes |
| CSV export of calls | — | yes |
| Listed in x402market | yes | yes |

Owner flow (admin key required):

```bash
# upgrade this service
curl -s -X POST .../api/x402gateway/api/services/<slug>/admin \
  -H 'X-Admin-Key: …' -H 'content-type: application/json' -d '{"action":"checkout"}'
# -> { url } — owner pays in the browser; the webhook flips the plan
# manage billing (cancel, invoices)
curl ... -d '{"action":"portal"}'
# current plan
curl ... -d '{"action":"plan"}'
# Pro only: recent calls + CSV export
curl ... -d '{"action":"usage"}'
curl .../api/services/<slug>/usage.csv -H 'X-Admin-Key: …'
```

Free services get a `402 { code: "plan_limit", plan, priceCents, upgrade }` when
they try to exceed 5 routes or read the analytics log.

### Stripe setup (operator)

```bash
cd x402-gateway
npx wrangler secret put STRIPE_SECRET_KEY       # restricted key: Checkout (write),
                                                # Customers (write), Subscriptions (write),
                                                # Billing Portal (write). Live key on prod.
npx wrangler secret put STRIPE_WEBHOOK_SECRET   # signing secret of the endpoint below
```

Webhook endpoint: `https://entangleit.com/x402gateway/webhooks/stripe` with events
`checkout.session.completed`, `customer.subscription.created|updated|deleted`,
`invoice.paid`, `invoice.payment_failed`. Checkout uses an ad-hoc monthly price
unless `STRIPE_PRICE_GATEWAY_PRO` is set. Webhook events are signature-verified
and deduped (`xgw_stripe_events`).

## Analytics dashboard

`/x402gateway/dashboard` renders per-service analytics:

- **Owner view**: `?service=<slug>` + admin key (kept in sessionStorage).
- **Public view**: mint a read-only link with `{"action":"share"}` (Pro) →
  `…/dashboard?token=xgw_dash_…`. `{"action":"shared"}` inspects it (views, last
  seen), `share` again rotates the token (old links stop working), and
  `{"action":"unshare"}` revokes it.
- **Free services** see aggregates only (calls, paid/free split, sats, error
  rate). **Pro services** additionally get per-day call/sats bar charts, the
  per-route breakdown with latency and error counts, the recent call log with
  WhatsOnChain tx links, and the CSV export.

API: `GET /api/services/:slug/analytics?days=7|30|90` (admin key) and
`GET /api/dashboards/:token/analytics?days=` (public token).

## Security model

- **SSRF guard** — upstreams must be `https://` and public; loopback, RFC1918,
  link-local, `*.internal`/`*.local`, and IPv6 ULA/link-local are rejected at
  registration *and* re-checked before every fetch.
- **No redirect following** — 3xx upstream responses are blocked (`upstream_redirect_blocked`)
  so a redirect cannot smuggle a private host.
- **Credential isolation** — the configured auth header is injected upstream and
  never returned by any API after registration; caller `Authorization` is not
  forwarded. Blocked header names (`host`, `content-length`, `cf-*`, …) can't be
  set as the auth header.
- **Replay guard** — a txid can pay for exactly one call (KV keyed by the
  deterministic tx txid).
- **Caps** — 20 routes/service, 1,000,000 sats max price, 64KB request, 512KB
  response, 20s timeout, per-IP rate limits, 5 registrations/IP/day.
- **No buyer keys** — the gateway only verifies and broadcasts buyer-signed
  transactions; it never holds funds.
- **Listing trust** — the gateway and the x402market registry share the same D1
  and operator, so the gateway writes its own verified listing directly (it is
  the source of truth for its routes and `payTo`). Tool paths are published on
  the workers.dev origin so the registry's quote/probe fetches are never
  same-zone.

## Starter catalog

`scripts/seed-catalog.mjs` registers the launch catalog (all listed in
x402market automatically):

| Service | Upstream | Paid routes |
| --- | --- | --- |
| DNS Resolver | Google DoH | `resolve` 2 sats (+ free `example`) |
| Wikipedia Brief | Wikipedia REST | `summary` 3 sats (`?title=`) |
| IP Geolocation | ipwho.is | `lookup` 3 sats (`?ip=`) |
| Weather Oracle | Open-Meteo | `forecast` 5 sats (`?latitude=&longitude=`) |
| Exchange Rates | open.er-api.com | `latest` 4 sats (`?base=`) |
| Hacker News Wire | HN Firebase | `top` / `item` 2 sats |
| Crypto Spot | Coinbase | `spot` 3 sats (`?pair=BSV-USD`) |
| Public Holidays | Nager.Date | `holidays` 3 sats (`?year=&country=`) |

```bash
node scripts/seed-catalog.mjs                       # default entangleit gateway
node scripts/seed-catalog.mjs http://127.0.0.1:8790 # local
```

## Fees

The hosted gateway is free during launch — sellers keep 100% of every payment
(`payTo` settles directly to the seller's address per call). Planned: Pro-style
hosted tiers for private upstreams, analytics, and higher route limits.

## Development

```bash
npm install
npm run db:apply:local     # xgw_ tables into the local shared D1
npm run dev                # :8790
npm test                   # 14 tests: validation, SSRF, paid proxy, replay, admin
npm run typecheck
npm run deploy             # attaches entangleit.com/x402gateway[/ *]
```

## Related — part of the EntangleIT agent economy

- [agentpay](https://entangleit.com/agentpay/) — prepaid agent wallets; `pay_service` settles these gateway routes automatically
- [x402market](https://entangleit.com/x402market/) — every paid gateway service is listed for discovery
- [BSVBounties](https://entangleit.com/bsvbounties/) — paid agent work with on-chain escrow
- [entangleit.com](https://entangleit.com/) — the factory site linking it all together
