#!/usr/bin/env node
/**
 * Register the starter catalog on the hosted x402 Gateway.
 * Each service auto-lists in x402market (verified listing).
 *
 *   node scripts/seed-catalog.mjs [gatewayBase]
 *
 * Default base: https://entangleit.com/x402gateway
 */
const BASE = (process.argv[2] || "https://entangleit.com/x402gateway").replace(/\/$/, "");
const PAY_TO = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";
const CONTACT = "richard.hein@gmail.com";

const SERVICES = [
  {
    name: "DNS Resolver",
    tagline: "DNS lookups over Google DNS-over-HTTPS",
    description:
      "Resolve A/AAAA/MX/TXT/NS records for any domain via Google's DoH JSON API. Agents use it for domain and deliverability checks.",
    baseUrl: "https://dns.google",
    routes: [
      { name: "resolve", method: "GET", path: "/resolve", priceSats: 2, description: "Resolve a record: params name, type (default A)" },
      { name: "example", method: "GET", path: "/resolve?name=example.com&type=A", priceSats: 0, description: "Free liveness probe for example.com" },
    ],
  },
  {
    name: "Wikipedia Brief",
    tagline: "Instant encyclopedia summaries for agents",
    description:
      "Wikipedia REST summary endpoint: title, extract, thumbnail, and canonical URL for any page. Useful for grounding and disambiguation.",
    baseUrl: "https://en.wikipedia.org/api/rest_v1/page/summary",
    routes: [
      { name: "summary", method: "GET", path: "/{title}", priceSats: 3, description: "Summary for a page title, e.g. ?title=Bitcoin" },
    ],
  },
  {
    name: "IP Geolocation",
    tagline: "IP address location and network details",
    description: "ipwho.is lookup: country, city, ISP/ASN, timezone, and flags for any IPv4/IPv6 address.",
    baseUrl: "https://ipwho.is",
    routes: [{ name: "lookup", method: "GET", path: "/{ip}", priceSats: 3, description: "Geolocate an IP, e.g. ?ip=8.8.8.8" }],
  },
  {
    name: "Weather Oracle",
    tagline: "Global forecasts from Open-Meteo",
    description:
      "Current conditions and hourly/daily forecasts for any coordinates. Pass latitude, longitude and any Open-Meteo parameters.",
    baseUrl: "https://api.open-meteo.com",
    routes: [
      {
        name: "forecast",
        method: "GET",
        path: "/v1/forecast",
        priceSats: 5,
        description: "Forecast JSON: latitude, longitude, current, hourly, daily",
      },
    ],
  },
  {
    name: "Exchange Rates",
    tagline: "Daily fiat exchange rates",
    description: "open.er-api.com latest rates for any base currency, with timestamp and next update.",
    baseUrl: "https://open.er-api.com",
    routes: [
      { name: "latest", method: "GET", path: "/v6/latest/{base}", priceSats: 4, description: "Latest rates for a base currency, e.g. ?base=USD" },
    ],
  },
  {
    name: "Hacker News Wire",
    tagline: "Hacker News top stories and items",
    description: "Firebase-backed HN feed: top story ids and item details (title, url, score, descendants).",
    baseUrl: "https://hacker-news.firebaseio.com",
    routes: [
      { name: "top", method: "GET", path: "/v0/topstories.json", priceSats: 2, description: "Top story ids" },
      { name: "item", method: "GET", path: "/v0/item/{id}.json", priceSats: 2, description: "Story/comment by id, e.g. ?id=8863" },
    ],
  },
  {
    name: "Crypto Spot",
    tagline: "Spot prices from Coinbase",
    description: "Coinbase spot price for any pair (BSV-USD, BTC-USD, ETH-USDC, …) with base/currency metadata.",
    baseUrl: "https://api.coinbase.com",
    routes: [
      { name: "spot", method: "GET", path: "/v2/prices/{pair}/spot", priceSats: 3, description: "Spot price for a pair, e.g. ?pair=BSV-USD" },
    ],
  },
  {
    name: "Public Holidays",
    tagline: "Official holidays by country and year",
    description: "Nager.Date public holidays: dates, local names, and flags for any ISO country code and year.",
    baseUrl: "https://date.nager.at",
    routes: [
      {
        name: "holidays",
        method: "GET",
        path: "/api/v3/PublicHolidays/{year}/{country}",
        priceSats: 3,
        description: "Holidays, e.g. ?year=2026&country=CA",
      },
    ],
  },
];

const results = [];
for (const service of SERVICES) {
  const res = await fetch(`${BASE}/api/services`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...service, payTo: PAY_TO, ownerContact: CONTACT }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    results.push({ name: service.name, ok: false, error: json?.error ?? `HTTP ${res.status}` });
    console.error(`FAIL ${service.name}: ${json?.error ?? res.status}`);
    continue;
  }
  results.push({ name: service.name, ok: true, slug: json.service.slug, registryId: json.listing?.serviceId });
  console.log(`ok   ${json.service.slug.padEnd(22)} routes=${json.service.routes.length} payTo=${json.service.payTo}`);
}

const okCount = results.filter((r) => r.ok).length;
console.log(`\n${okCount}/${results.length} services registered`);
if (okCount !== results.length) {
  console.log("failures:", JSON.stringify(results.filter((r) => !r.ok), null, 1));
  process.exit(1);
}
