import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, saveProfile } from "../cli/config.js";
import { serviceFiles, unitFile } from "../cli/service.js";

function home(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-profile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("profile credentials are private and not reused for another identity or API origin", t => {
  const dir = home(t);
  saveProfile(dir, { apiKey: "example", signingKey: "local", baseUrl: "https://example.test", identity: "first",
    allowedSenders: ["owner@example.test"], outbound: { approval: "auto" } });
  assert.equal(statSync(path.join(dir, "config.json")).mode & 0o777, 0o600);
  const env = { HOME: dir, INKBOX_PI_HOME: dir };
  assert.equal(loadConfig(env).apiKey, "example");
  for (const override of [{ INKBOX_IDENTITY: "second" }, { INKBOX_BASE_URL: "https://other.test" }]) {
    const config = loadConfig({ ...env, ...override });
    assert.equal(config.signingKey, "");
    assert.equal(config.apiKey, "");
    assert.deepEqual(config.allowedSenders, []);
    assert.deepEqual(config.outbound, {});
  }
});

test("explicit webhook URL requires a stable port", t => {
  const dir = home(t);
  const env = { HOME: dir, INKBOX_PI_HOME: dir, INKBOX_PI_PUBLIC_URL: "https://pi.example.test" };
  assert.ok(loadConfig(env).port > 0);
  assert.throws(() => loadConfig({ ...env, INKBOX_PI_PORT: "0" }), /fixed port/);
});

test("background services are isolated per profile and preserve literal argument boundaries", () => {
  const regular = serviceFiles("/user/one");
  assert.notEqual(regular.name, serviceFiles("/user/two").name);
  const unit = unitFile("/node", "/path with space/bin", "/profile%h/$x");
  assert.match(unit, /"\/path with space\/bin" "service-run" "\/profile%%h\/\$\$x"/);
  assert.throws(() => unitFile("/node\n[Service]", "pi", "/home"));
});

test("the shared SDK profile is an origin- and identity-bound fallback", async t => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const account = home(t);
  mkdirSync(path.join(account, ".inkbox"));
  writeFileSync(path.join(account, ".inkbox/config"), "# example\nidentity = demo\napi_key = 'sample'\nbase_url = https://mail.example.test\nsigning_key = test\n");
  const env = { HOME: account };
  assert.equal(loadConfig(env).baseUrl, "https://mail.example.test");
  assert.equal(loadConfig(env).apiKey, "sample");
  assert.equal(loadConfig(env).signingKey, "test");
  assert.equal(loadConfig({ ...env, INKBOX_BASE_URL: "https://other.example.test" }).apiKey, "");
  assert.equal(loadConfig({ ...env, INKBOX_IDENTITY: "other" }).signingKey, "");
});

test("a service only retains model credentials explicitly selected by its owner", async () => {
  const { modelEnvironment } = await import("../cli/model-env.js");
  const env = { OPENAI_API_KEY: "sample", XAI_API_KEY: "other", UNRELATED: "unrelated" };
  assert.deepEqual(modelEnvironment(env), {});
  assert.deepEqual(modelEnvironment({ ...env, INKBOX_PI_MODEL_ENV: "XAI_API_KEY" }), { XAI_API_KEY: "other" });
  assert.deepEqual(modelEnvironment({ INKBOX_PI_MODEL_ENV: "" }, { XAI_API_KEY: "old" }), {});
  assert.throws(() => modelEnvironment({ ...env, INKBOX_PI_MODEL_ENV: "UNRELATED" }));
});
