import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configure } from "../cli/setup.js";
import { loadConfig, readProfile, saveProfile } from "../cli/config.js";

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), "pi-setup-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = loadConfig({ HOME: home, INKBOX_PI_HOME: home });
  const counts = { minted: 0, signed: 0 };
  const identity = {
    agentHandle: "pi-example", id: "agent-id",
    async getSigningKeyStatus() { return { configured: counts.signed > 0 }; },
    async createSigningKey() { counts.signed++; return { signingKey: "signed-" + counts.signed }; },
  };
  function clientFor(key) {
    const admin = key === "example-admin";
    return {
      whoami: async () => ({ authType: "api_key", authSubtype: admin ? "api_key.admin_scoped" : "api_key.agent_scoped.claimed" }),
      listIdentities: async () => [identity], getIdentity: async () => identity,
      apiKeys: { create: async () => { counts.minted++; return { apiKey: "example-scoped" }; } },
    };
  }
  return { home, config, counts, clientFor };
}

test("bootstrap never persists admin keys or rotates existing keys on retry", async t => {
  const { home, config, counts, clientFor } = fixture(t);
  const options = { identity: "pi-example", key: "example-admin" };
  for (let i = 0; i < 2; i++) assert.equal((await configure(config, options, undefined, clientFor)).ready, true);
  assert.equal(readProfile(home).apiKey, "example-scoped");
  assert.deepEqual(counts, { signed: 1, minted: 1 });
});

test("missing existing signing key doesn't rotate it without explicit consent", async t => {
  const { home, config, counts, clientFor } = fixture(t);
  counts.signed = 1;
  const options = { identity: "pi-example", key: "example-scoped" };
  assert.equal((await configure(config, options, undefined, clientFor)).ready, false);
  assert.equal(counts.signed, 1);
  assert.equal(readProfile(home).signingKey, undefined);
  assert.equal((await configure(config, { ...options, rotate: true }, undefined, clientFor)).ready, true);
  assert.equal(counts.signed, 2);
});

test("a mismatched agent-scoped key cannot replace a working profile", async t => {
  const { home, config, clientFor } = fixture(t);
  saveProfile(home, { identity: "prior" });
  await assert.rejects(configure(config, { identity: "other", key: "different" }, undefined, clientFor), /does not match/);
  assert.deepEqual(readProfile(home), { identity: "prior" });
});
