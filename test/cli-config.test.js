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

test("profile credentials are private and not reused for another identity or API origin", (t) => {
  const dir = home(t);
  saveProfile(dir, {
    apiKey: "example",
    signingKey: "local",
    baseUrl: "https://example.test",
    identity: "first",
    allowedSenders: ["owner@example.test"],
    outbound: { approval: "auto" },
  });
  assert.equal(statSync(path.join(dir, "config.json")).mode & 0o777, 0o600);
  const env = { HOME: dir, INKBOX_PI_HOME: dir };
  assert.equal(loadConfig(env).apiKey, "example");
  for (const override of [
    { INKBOX_IDENTITY: "second" },
    { INKBOX_BASE_URL: "https://other.test" },
  ]) {
    const config = loadConfig({ ...env, ...override });
    assert.equal(config.signingKey, "");
    assert.equal(config.apiKey, "");
    assert.deepEqual(config.allowedSenders, []);
    assert.deepEqual(config.outbound, {});
  }
});

test("explicit webhook URL requires a stable port", (t) => {
  const dir = home(t);
  const env = {
    HOME: dir,
    INKBOX_PI_HOME: dir,
    INKBOX_PI_PUBLIC_URL: "https://pi.example.test",
  };
  assert.ok(loadConfig(env).port > 0);
  assert.throws(
    () => loadConfig({ ...env, INKBOX_PI_PORT: "0" }),
    /fixed port/,
  );
});

test("background services are isolated per profile and preserve literal argument boundaries", () => {
  const regular = serviceFiles("/user/one");
  assert.notEqual(regular.name, serviceFiles("/user/two").name);
  const unit = unitFile("/node", "/path with space/bin", "/profile%h/$x");
  assert.match(
    unit,
    /"\/path with space\/bin" "service-run" "\/profile%%h\/\$\$x"/,
  );
  assert.throws(() => unitFile("/node\n[Service]", "pi", "/home"));
});

test("the shared SDK profile is an origin- and identity-bound fallback", async (t) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const account = home(t);
  mkdirSync(path.join(account, ".inkbox"));
  writeFileSync(
    path.join(account, ".inkbox/config"),
    "# example\nidentity = demo\napi_key = 'sample'\nbase_url = https://mail.example.test\nsigning_key = test\n",
  );
  const env = { HOME: account };
  assert.equal(loadConfig(env).baseUrl, "https://mail.example.test");
  assert.equal(loadConfig(env).apiKey, "sample");
  assert.equal(loadConfig(env).signingKey, "test");
  assert.equal(
    loadConfig({ ...env, INKBOX_BASE_URL: "https://other.example.test" })
      .apiKey,
    "",
  );
  assert.equal(loadConfig({ ...env, INKBOX_IDENTITY: "other" }).signingKey, "");
});

test("a service only retains model credentials explicitly selected by its owner", async () => {
  const { modelEnvironment } = await import("../cli/model-env.js");
  const env = {
    OPENAI_API_KEY: "sample",
    XAI_API_KEY: "other",
    UNRELATED: "unrelated",
  };
  assert.deepEqual(modelEnvironment(env), {});
  assert.deepEqual(
    modelEnvironment({ ...env, INKBOX_PI_MODEL_ENV: "XAI_API_KEY" }),
    { XAI_API_KEY: "other" },
  );
  assert.deepEqual(
    modelEnvironment({ INKBOX_PI_MODEL_ENV: "" }, { XAI_API_KEY: "old" }),
    {},
  );
  assert.throws(() =>
    modelEnvironment({ ...env, INKBOX_PI_MODEL_ENV: "UNRELATED" }),
  );
});

test("a separate Pi profile does not depend on a valid shared SDK origin", async (t) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const account = home(t),
    dir = path.join(account, ".inkbox-pi");
  mkdirSync(path.join(account, ".inkbox"));
  writeFileSync(
    path.join(account, ".inkbox/config"),
    "identity = shared\nbase_url = invalid\napi_key = other\n",
  );
  saveProfile(dir, {
    baseUrl: "https://example.test",
    identity: "local",
    apiKey: "selected",
  });
  const config = loadConfig({ HOME: account, INKBOX_PI_HOME: dir });
  assert.equal(config.apiKey, "selected");
});

test("teardown works even when the profile cannot be parsed", async (t) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const dir = home(t);
  const profile = path.join(dir, ".inkbox-pi");
  mkdirSync(profile);
  writeFileSync(path.join(profile, "config.json"), "bad json");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/inkbox-pi.js", import.meta.url));
  const result = spawnSync(process.execPath, [bin, "stop"], {
    env: { ...process.env, HOME: dir, INKBOX_PI_HOME: profile },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("login services resolve the real executable behind a transient shell PATH", async (t) => {
  const { servicePiPaths, servicePiCommand } = await import(
    "../cli/service.js"
  );
  const { symlinkSync, writeFileSync, unlinkSync, realpathSync } = await import(
    "node:fs"
  );
  const dir = home(t);
  const target = path.join(dir, "installed-pi");
  const launcher = path.join(dir, "pi");
  writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync(target, launcher);
  const selected = servicePiPaths("pi", dir);
  assert.equal(path.basename(servicePiCommand(selected)), "pi");
  unlinkSync(launcher);
  assert.equal(servicePiCommand(selected), realpathSync(target));
  assert.equal(
    servicePiCommand(servicePiPaths(target, dir)),
    realpathSync(target),
  );
  assert.throws(
    () => servicePiPaths("pi", dir),
    /Cannot find an executable Pi/,
  );
});

test("contact memories, the approval timeout and auto-allowed tools load from the profile and environment", (t) => {
  const dir = home(t);
  const env = { HOME: dir, INKBOX_PI_HOME: dir };
  saveProfile(dir, { identity: "owner" });
  const defaults = loadConfig(env);
  assert.equal(defaults.contactMemories, true);
  assert.equal(defaults.permissionTimeoutS, 600);
  // Undefined selects the gateway's own read-only default list.
  assert.equal(defaults.autoAllowedTools, undefined);

  saveProfile(dir, {
    identity: "owner",
    contactMemories: false,
    permissionTimeoutS: 120,
    autoAllowedTools: ["read", "bash"],
  });
  const saved = loadConfig(env);
  assert.equal(saved.contactMemories, false);
  assert.equal(saved.permissionTimeoutS, 120);
  assert.deepEqual(saved.autoAllowedTools, ["read", "bash"]);

  const fromEnv = loadConfig({
    ...env,
    INKBOX_CONTACT_MEMORIES_ENABLED: "true",
    INKBOX_PERMISSION_TIMEOUT_S: "30",
    INKBOX_PI_AUTO_ALLOWED_TOOLS: " read, grep ,,ls ",
  });
  assert.equal(fromEnv.contactMemories, true);
  assert.equal(fromEnv.permissionTimeoutS, 30);
  assert.deepEqual(fromEnv.autoAllowedTools, ["read", "grep", "ls"]);
  // An empty list is a choice: every Pi tool asks first.
  assert.deepEqual(
    loadConfig({ ...env, INKBOX_PI_AUTO_ALLOWED_TOOLS: "" }).autoAllowedTools,
    [],
  );

  for (const bad of ["9", "1501", "1.5", "soon"])
    assert.throws(
      () => loadConfig({ ...env, INKBOX_PERMISSION_TIMEOUT_S: bad }),
      /permissionTimeoutS/,
    );
  for (const edge of ["10", "1500"])
    assert.equal(
      loadConfig({ ...env, INKBOX_PERMISSION_TIMEOUT_S: edge })
        .permissionTimeoutS,
      Number(edge),
    );
  assert.throws(
    () => loadConfig({ ...env, INKBOX_CONTACT_MEMORIES_ENABLED: "yes" }),
    /true or false/,
  );
  saveProfile(dir, { identity: "owner", autoAllowedTools: "read" });
  assert.throws(() => loadConfig(env), /list of strings/);
});

test("contact memories are on unless turned off, also without a saved profile for the identity", (t) => {
  const dir = home(t);
  const env = { HOME: dir, INKBOX_PI_HOME: dir };
  assert.equal(loadConfig(env).contactMemories, true);
  assert.equal(
    loadConfig({ ...env, INKBOX_CONTACT_MEMORIES_ENABLED: "false" })
      .contactMemories,
    false,
  );
  saveProfile(dir, { identity: "owner", contactMemories: false });
  assert.equal(loadConfig(env).contactMemories, false);
  assert.equal(
    loadConfig({ ...env, INKBOX_IDENTITY: "other" }).contactMemories,
    true,
  );
});

test("trusting Inkbox tools is off until the profile or the environment turns it on", (t) => {
  const dir = home(t);
  const env = { HOME: dir, INKBOX_PI_HOME: dir };
  assert.equal(loadConfig(env).autoApproveInkboxTools, false);
  assert.equal(
    loadConfig({ ...env, INKBOX_PI_AUTO_APPROVE_INKBOX_TOOLS: "true" })
      .autoApproveInkboxTools,
    true,
  );
  saveProfile(dir, { identity: "owner", autoApproveInkboxTools: true });
  assert.equal(loadConfig(env).autoApproveInkboxTools, true);
  assert.equal(
    loadConfig({ ...env, INKBOX_PI_AUTO_APPROVE_INKBOX_TOOLS: "false" })
      .autoApproveInkboxTools,
    false,
  );
  // A choice saved for one identity is not carried to another.
  assert.equal(
    loadConfig({ ...env, INKBOX_IDENTITY: "other" }).autoApproveInkboxTools,
    false,
  );
  assert.throws(
    () => loadConfig({ ...env, INKBOX_PI_AUTO_APPROVE_INKBOX_TOOLS: "yes" }),
    /autoApproveInkboxTools/,
  );
});

test("a saved approval timeout and tool list belong to the identity they were saved for", (t) => {
  const dir = home(t);
  const env = { HOME: dir, INKBOX_PI_HOME: dir };
  saveProfile(dir, {
    identity: "owner",
    permissionTimeoutS: 120,
    autoAllowedTools: ["read", "bash"],
  });
  assert.equal(loadConfig(env).permissionTimeoutS, 120);
  const other = loadConfig({ ...env, INKBOX_IDENTITY: "other" });
  assert.equal(other.permissionTimeoutS, 600);
  // Not an empty list: the other identity gets the default read-only tools.
  assert.equal(other.autoAllowedTools, undefined);
  assert.deepEqual(
    loadConfig({
      ...env,
      INKBOX_IDENTITY: "other",
      INKBOX_PI_AUTO_ALLOWED_TOOLS: "ls",
    }).autoAllowedTools,
    ["ls"],
  );
});

test("settings of the removed file-grant model are ignored, not loaded or validated", (t) => {
  const dir = home(t);
  saveProfile(dir, {
    identity: "owner",
    trustedConversations: ["not-a-binding"],
    toolConversations: ["not-a-binding"],
    trustedAgentIds: ["peer"],
    projectFiles: ["notes.md"],
    projectReadWorkspace: "yes",
    projectTestCommand: "npm test",
  });
  const config = loadConfig({
    HOME: dir,
    INKBOX_PI_HOME: dir,
    INKBOX_PI_TRUSTED_CONVERSATIONS: "not-a-binding",
    INKBOX_PI_PROJECT_TEST_COMMAND: "npm test",
    INKBOX_PI_PROJECT_READ_WORKSPACE: "yes",
  });
  assert.equal(config.identity, "owner");
  for (const key of [
    "trustedConversations",
    "toolConversations",
    "trustedAgentIds",
    "projectFiles",
    "projectReadWorkspace",
    "projectTestCommand",
  ])
    assert.ok(!(key in config), key);
});
