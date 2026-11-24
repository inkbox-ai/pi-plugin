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
  const env = { INKBOX_PI_HOME: dir };
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
  const env = { INKBOX_PI_HOME: home(t), INKBOX_PI_PUBLIC_URL: "https://pi.example.test" };
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
