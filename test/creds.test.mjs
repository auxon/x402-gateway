import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decryptAuthValue, encryptAuthValue, isEncryptedAuthValue } from "../src/creds.ts";

function keyEnv() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { GATEWAY_CREDS_KEY: btoa(bin) };
}

describe("gateway credential encryption", () => {
  it("round-trips auth secrets", async () => {
    const env = keyEnv();
    const enc = await encryptAuthValue(env, "Bearer sk-live-123");
    assert.equal(isEncryptedAuthValue(enc), true);
    assert.equal(await decryptAuthValue(env, enc), "Bearer sk-live-123");
  });
  it("legacy plaintext passes through", async () => {
    const env = keyEnv();
    assert.equal(await decryptAuthValue(env, "Bearer plain"), "Bearer plain");
    assert.equal(await decryptAuthValue(env, ""), "");
  });
  it("wrong key fails closed", async () => {
    const enc = await encryptAuthValue(keyEnv(), "secret");
    await assert.rejects(decryptAuthValue(keyEnv(), enc));
  });
});
