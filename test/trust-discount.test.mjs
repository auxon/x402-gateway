import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discountSats, verifyTrustForDiscount } from "../src/trust.ts";
import { manifestFor } from "../src/index.ts";
import { validateServiceInput } from "../src/store.ts";

const PAY_TO = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";

describe("trust discounts", () => {
  it("discountSats math (20% off 20 = 16)", () => {
    assert.equal(discountSats(20, 2000), 16);
    assert.equal(discountSats(20, 0), 20);
    assert.equal(discountSats(1, 5000), 1); // never prices to zero
    assert.equal(discountSats(0, 5000), 0);
  });

  it("route validation clamps trustDiscountBps", () => {
    const base = {
      name: "ab",
      baseUrl: "https://api.example.com",
      payTo: PAY_TO,
      routes: [{ name: "tool", method: "GET", path: "/t", priceSats: 20, trustDiscountBps: 2500 }],
    };
    const ok = validateServiceInput(base, 5);
    assert.equal(ok.routes[0].trustDiscountBps, 2500);
    assert.throws(() => validateServiceInput({ ...base, routes: [{ name: "t", method: "GET", path: "/t", priceSats: 1, trustDiscountBps: 10001 }] }, 5));
    const def = validateServiceInput({ ...base, routes: [{ name: "t", method: "GET", path: "/t", priceSats: 1 }] }, 5);
    assert.equal(def.routes[0].trustDiscountBps, 0);
  });

  it("manifest advertises trust acceptance", () => {
    const row = {
      id: "x",
      slug: "s",
      name: "n",
      tagline: "",
      description: "",
      base_url: "https://api.example.com",
      auth_header: "",
      auth_value: "",
      pay_to: PAY_TO,
      owner_contact: "",
      admin_key_hash: "",
      status: "active",
      routes_json: JSON.stringify([{ name: "t", method: "GET", path: "/t", priceSats: 20, description: "", trustDiscountBps: 1000 }]),
      registry_id: "",
      total_calls: 0,
      total_sats: 0,
      created_at: "",
      updated_at: "",
    };
    const m = manifestFor({}, row, "https://x.example");
    assert.equal(m.tools[0].trustAccepted, true);
    assert.equal(m.tools[0].trustDiscountBps, 1000);
  });

  it("missing header fails closed to full price (no error)", async () => {
    const r = await verifyTrustForDiscount({}, undefined, null);
    assert.equal(r.eligible, false);
  });
});
