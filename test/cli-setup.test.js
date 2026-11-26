import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configure, signingKeyReady } from "../cli/setup.js";
import { loadConfig, readProfile, saveProfile } from "../cli/config.js";

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), "pi-setup-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = loadConfig({ HOME: home, INKBOX_PI_HOME: home });
  const counts = { minted: 0, signed: 0 };
  const identity = {
    agentHandle: "pi-example",
    id: "agent-id",
    async getSigningKeyStatus() {
      return { configured: counts.signed > 0 };
    },
    async createSigningKey() {
      counts.signed++;
      return { signingKey: "signed-" + counts.signed };
    },
  };
  function clientFor(key) {
    const admin = key === "example-admin";
    return {
      whoami: async () => ({
        authType: "api_key",
        authSubtype: admin
          ? "api_key.admin_scoped"
          : "api_key.agent_scoped.claimed",
      }),
      listIdentities: async () => [identity],
      getIdentity: async () => identity,
      apiKeys: {
        create: async () => {
          counts.minted++;
          return { apiKey: "example-scoped" };
        },
      },
    };
  }
  return { home, config, counts, clientFor };
}

test("bootstrap never persists admin keys or rotates existing keys on retry", async (t) => {
  const { home, config, counts, clientFor } = fixture(t);
  const options = { identity: "pi-example", key: "example-admin" };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await configure(config, options, undefined, clientFor)).ready,
      true,
    );
  assert.equal(readProfile(home).apiKey, "example-scoped");
  assert.deepEqual(counts, { signed: 1, minted: 1 });
});

test("missing existing signing key doesn't rotate it without explicit consent", async (t) => {
  const { home, config, counts, clientFor } = fixture(t);
  counts.signed = 1;
  const options = { identity: "pi-example", key: "example-scoped" };
  assert.equal(
    (await configure(config, options, undefined, clientFor)).ready,
    false,
  );
  assert.equal(counts.signed, 1);
  assert.equal(readProfile(home).signingKey, undefined);
  assert.equal(
    (
      await configure(
        config,
        { ...options, rotate: true },
        undefined,
        clientFor,
      )
    ).ready,
    true,
  );
  assert.equal(counts.signed, 2);
});

test("a mismatched agent-scoped key cannot replace a working profile", async (t) => {
  const { home, config, clientFor } = fixture(t);
  saveProfile(home, { identity: "prior" });
  await assert.rejects(
    configure(
      config,
      { identity: "other", key: "different" },
      undefined,
      clientFor,
    ),
    /does not match/,
  );
  assert.deepEqual(readProfile(home), { identity: "prior" });
});

test("bootstrap cannot restamp a locally saved signing key after server rotation", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { home } = fixture(t);
  const identity = { agent_handle: "pi-example", id: "agent-id" };
  const api = createServer((req, res) => {
    const route = req.url.replace(/\/$/, "");
    let body;
    if (route === "/api/whoami")
      body = {
        auth_type: "api_key",
        auth_subtype: "api_key.agent_scoped.claimed",
      };
    else if (route === "/api/v1/identities") body = [identity];
    else if (route === "/api/v1/identities/pi-example") body = identity;
    else if (
      route === "/api/v1/identities/pi-example/signing-key" &&
      req.method === "GET"
    )
      body = { configured: true, created_at: "2026-01-02T00:00:00Z" };
    else {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(body));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  t.after(() => api.close());
  const baseUrl = "http://127.0.0.1:" + api.address().port;
  saveProfile(home, {
    baseUrl,
    identity: identity.agent_handle,
    apiKey: "test-key",
    signingKey: "stale",
    signingKeyCreatedAt: "2026-01-01T00:00:00.000Z",
  });
  const script = fileURLToPath(new URL("../bin/inkbox-pi.js", import.meta.url));
  const env = { HOME: home, INKBOX_PI_HOME: home, PATH: process.env.PATH };
  const bootstrap = () =>
    promisify(execFile)(process.execPath, [script, "bootstrap"], { env });
  await assert.rejects(
    bootstrap,
    (error) => error.code === 2 && /requires_human/.test(error.stdout),
  );
  assert.equal(readProfile(home).signingKey, undefined);
  mkdirSync(path.join(home, ".inkbox"));
  const shared = (key) =>
    writeFileSync(
      path.join(home, ".inkbox/config"),
      "base_url = " +
        baseUrl +
        "\nidentity = pi-example\nsigning_key = " +
        key +
        "\n",
    );
  shared("stale");
  await assert.rejects(
    bootstrap,
    (error) => error.code === 2 && /requires_human/.test(error.stdout),
  );
  assert.equal(loadConfig(env).signingKey, "");
  shared("replacement");
  const completed = await bootstrap();
  assert.equal(JSON.parse(completed.stdout).status, "configured");
  assert.equal(readProfile(home).signingKey, "replacement");
});

test("replacing a revoked key is masked and leaves the saved profile untouched until verified", async (t) => {
  const { home, config, clientFor } = fixture(t);
  const existing = {
    baseUrl: config.baseUrl,
    identity: "pi-example",
    apiKey: "revoked",
  };
  saveProfile(home, existing);
  const io = {
    secret: async () => "wrong",
    confirm: async () => false,
    print() {},
  };
  const options = { replaceKey: true, projectDir: home };
  const current = loadConfig({ HOME: home, INKBOX_PI_HOME: home });
  await assert.rejects(
    configure(current, options, io, () => ({
      async whoami() {
        throw Object.assign(new Error("private"), { statusCode: 401 });
      },
    })),
  );
  assert.deepEqual(readProfile(home), existing);
  io.secret = async () => "new-scoped";
  assert.equal((await configure(current, options, io, clientFor)).ready, true);
  assert.equal(readProfile(home).apiKey, "new-scoped");
});

test("setup asks whether to trust Inkbox tools, defaulting to yes; unattended setup trusts them unless a choice was saved", async (t) => {
  const { home, config, clientFor } = fixture(t);
  const options = { identity: "pi-example", key: "example-admin" };
  await configure(config, options, undefined, clientFor);
  assert.equal(readProfile(home).autoApproveInkboxTools, true);

  const asked = [];
  let answer = false;
  const io = {
    ask: async () => "",
    secret: async () => "",
    print() {},
    confirm: async (message, fallback) => {
      asked.push([message, fallback]);
      return /Inkbox tools/.test(message) ? answer : false;
    },
  };
  const current = () => loadConfig({ HOME: home, INKBOX_PI_HOME: home });
  await configure(current(), { projectDir: home }, io, clientFor);
  const question = asked.find(([message]) => /Inkbox tools/.test(message));
  assert.match(question[0], /without asking each time/);
  assert.equal(question[1], true);
  assert.equal(readProfile(home).autoApproveInkboxTools, false);
  assert.equal(current().autoApproveInkboxTools, false);

  // A saved "no" becomes the default answer and survives unattended setup.
  asked.length = 0;
  await configure(current(), options, undefined, clientFor);
  assert.equal(readProfile(home).autoApproveInkboxTools, false);
  answer = true;
  await configure(current(), { projectDir: home }, io, clientFor);
  assert.equal(
    asked.find(([message]) => /Inkbox tools/.test(message))[1],
    false,
  );
  assert.equal(readProfile(home).autoApproveInkboxTools, true);
});

test("setup hands incoming calls to the call agent when the identity can take calls, unless declined", async (t) => {
  const { home, config, clientFor } = fixture(t);
  const options = { identity: "pi-example", key: "example-admin" };
  const base = await clientFor("example-scoped").getIdentity();
  let action = "auto_accept";
  const changes = [];
  const phone = Object.assign(base, {
    getIncomingCallAction: async () => ({ incomingCallAction: action }),
    setIncomingCallAction: async (change) => {
      changes.push(change);
      action = change.incomingCallAction;
    },
  });
  // No number and no iMessage: there are no calls to answer.
  await configure(config, options, undefined, clientFor);
  assert.deepEqual(changes, []);

  phone.phoneNumber = { number: "+12025550101" };
  await configure(config, options, undefined, clientFor);
  assert.deepEqual(changes, [{ incomingCallAction: "hosted_agent" }]);
  // Already answered by the call agent: nothing to change.
  await configure(config, options, undefined, clientFor);
  assert.equal(changes.length, 1);

  action = "auto_accept";
  const asked = [];
  let accept = false;
  const io = {
    ask: async () => "",
    secret: async () => "",
    print() {},
    confirm: async (message, fallback) => {
      asked.push([message, fallback]);
      return /call agent/.test(message) ? accept : false;
    },
  };
  const current = () => loadConfig({ HOME: home, INKBOX_PI_HOME: home });
  await configure(current(), { projectDir: home }, io, clientFor);
  assert.deepEqual(
    asked.find(([message]) => /call agent/.test(message)),
    ["Let Inkbox's call agent answer phone calls to this agent?", true],
  );
  assert.equal(changes.length, 1);
  accept = true;
  await configure(current(), { projectDir: home }, io, clientFor);
  assert.deepEqual(changes[1], { incomingCallAction: "hosted_agent" });
});

test("readiness rejects a known rotated key without mutating the saved profile", async (t) => {
  const { config, home } = fixture(t);
  const saved = {
    baseUrl: config.baseUrl,
    identity: "pi-example",
    signingKey: "original",
    signingKeyCreatedAt: "2026-01-01T00:00:00.000Z",
  };
  saveProfile(home, saved);
  const owner = {
    agentHandle: saved.identity,
    getSigningKeyStatus: async () => ({
      configured: true,
      createdAt: "2026-01-02T00:00:00Z",
    }),
  };
  assert.equal(await signingKeyReady({ ...config, ...saved }, owner), false);
  assert.equal(
    await signingKeyReady(
      { ...config, ...saved, signingKey: "replacement" },
      owner,
    ),
    true,
  );
  assert.deepEqual(readProfile(home), saved);
});

test("non-interactive key replacement fails rather than reporting setup success", async () => {
  const { main } = await import("../cli/index.js");
  await assert.rejects(
    main(["setup", "--replace-key", "--print"]),
    /interactive terminal/,
  );
});
