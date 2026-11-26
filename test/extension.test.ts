import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inkbox } from "@inkbox/sdk";
import { loadConfig } from "../cli/config.js";
import inkbox, { registerInkbox } from "../extension/index.ts";
import { approveOutbound } from "../extension/permissions.ts";
import { isToolEnabled } from "../extension/selection.js";
import { whatsappTools } from "../extension/tools/whatsapp.ts";
import { PERMISSION_TITLE } from "../gateway/pi-rpc.js";
import gatewayTurn from "../gateway/turn-extension.ts";

// The slice of Pi's extension API this package registers against.
function host() {
  const tools = new Map(),
    commands = new Map(),
    handlers = new Map();
  return {
    tools,
    commands,
    handlers,
    pi: {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: (name, c) => commands.set(name, c),
      on: (name, handler) => handlers.set(name, handler),
    } as any,
  };
}

// A profile read from an empty home, so no saved or shared account is used.
function profile(t, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), "inkbox-pi-test-"));
  t.after(() => rmSync(home, { force: true, recursive: true }));
  return { ...loadConfig({ INKBOX_PI_HOME: home, HOME: home }), ...overrides };
}

const credentials = { apiKey: "fixture-key", identity: "pi-agent" };

// Answer the SDK's identity checks locally; `identity` can be replaced per case.
function live(t) {
  const sdk = { identity: undefined as any };
  t.mock.method(Inkbox.prototype, "whoami", async () => ({
    authType: "api_key",
    authSubtype: "api_key.agent_scoped.claimed",
  }));
  t.mock.method(Inkbox.prototype, "listIdentities", async () => [sdk.identity]);
  t.mock.method(Inkbox.prototype, "getIdentity", async () => sdk.identity);
  return sdk;
}

const session = (extra = {}) =>
  ({
    sessionManager: { getSessionId: () => "session-1" },
    cwd: process.cwd(),
    hasUI: false,
    ...extra,
  }) as any;

async function run(tool, args, ctx = session(), signal?: AbortSignal) {
  const result = await tool.execute("call-1", args, signal, undefined, ctx);
  return result.content[0].text;
}

test("Pi can register tools without credentials and shows setup commands", async () => {
  const home = mkdtempSync(join(tmpdir(), "inkbox-pi-test-"));
  const previous = process.env.INKBOX_PI_HOME;
  process.env.INKBOX_PI_HOME = home;
  try {
    const tools = new Map(),
      commands = new Map();
    inkbox({
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: (name, c) => commands.set(name, c),
    });
    assert(commands.has("inkbox-status"));
    assert(commands.has("inkbox"));
    for (const name of [
      "inkbox_send_email",
      "inkbox_send_sms",
      "inkbox_send_imessage",
      "inkbox_a2a_check",
      "inkbox_list_whatsapp_messages",
      "inkbox_doctor",
      "inkbox_whoami",
    ])
      assert(tools.has(name), name);
    assert(!tools.has("inkbox_slack_search"));
    assert(!tools.has("inkbox_credentials_get_secret"));
    for (const name of [
      "inkbox_place_call",
      "inkbox_list_calls",
      "inkbox_list_call_transcripts",
    ])
      assert(tools.has(name), name);
    assert.equal(tools.get("inkbox_send_sms").parameters.type, "object");
    const tool = tools.get("inkbox_send_email");
    await assert.rejects(
      () =>
        tool.execute(
          "native-call-id",
          { to: ["recipient@example.com"], subject: "hi" },
          undefined,
          undefined,
          { sessionManager: { getSessionId: () => "local" }, hasUI: false },
        ),
      /not approved/,
    );
    // With a terminal, the same confirmation is Pi's own dialog.
    const dialogs = [];
    await assert.rejects(
      run(
        tool,
        { to: ["recipient@example.com"], subject: "hi" },
        session({
          hasUI: true,
          ui: {
            confirm: async (title) => {
              dialogs.push(title);
              return false;
            },
          },
        }),
      ),
      /not approved/,
    );
    assert.deepEqual(dialogs, ["inkbox_send_email"]);
  } finally {
    if (previous === undefined) delete process.env.INKBOX_PI_HOME;
    else process.env.INKBOX_PI_HOME = previous;
    rmSync(home, { force: true, recursive: true });
  }
});

test("every tool in the catalog is listed with a one-line prompt snippet", async (t) => {
  const config = profile(t, { slackEnabled: true });
  const defaults = host();
  registerInkbox(defaults.pi, { ...config, tools: { enable: ["all"] } });
  // Sensitive tools need their exact names; the doctor reports what is still off.
  const { disabledTools } = JSON.parse(
    await run(defaults.tools.get("inkbox_doctor"), {}),
  );
  const { pi, tools } = host();
  registerInkbox(pi, {
    ...config,
    tools: { enable: ["all", ...disabledTools] },
  });
  const status = JSON.parse(await run(tools.get("inkbox_doctor"), {}));
  assert.deepEqual(status.disabledTools, []);
  assert.deepEqual([...tools.keys()].sort(), [...status.enabledTools].sort());
  assert.ok(tools.size > defaults.tools.size);
  assert.ok(tools.has("inkbox_slack_search"));
  for (const tool of tools.values()) {
    assert.equal(typeof tool.promptSnippet, "string", tool.name);
    assert.ok(tool.promptSnippet.trim(), tool.name);
    assert.ok(!tool.promptSnippet.includes("\n"), tool.name);
    assert.ok(tool.description.startsWith(tool.promptSnippet), tool.name);
  }
});

test("a call is handed to the call agent with its task, after the usual approval", async (t) => {
  const placed = [];
  live(t).identity = {
    id: "identity-1",
    agentHandle: "pi-agent",
    placeCall: async (options) => {
      placed.push(options);
      return { id: "call-1", status: "initiated" };
    },
    listCalls: async ({ limit }) => [
      {
        id: "call-1",
        direction: "outbound",
        remotePhoneNumber: "+12025550102",
        status: "completed",
        hangupReason: "remote",
        startedAt: new Date("2026-01-02T03:04:05Z"),
        reason: "Confirm the appointment",
        limit,
      },
    ],
    listTranscripts: async () => [
      { seq: 2, party: "remote", text: "Yes, Tuesday works." },
      { seq: 1, party: "local", text: "Is Tuesday still good?" },
    ],
  };
  const asked = [];
  const { pi, tools } = host();
  registerInkbox(pi, profile(t, credentials), {
    confirm: async (_ctx, request) => {
      asked.push(request);
      return true;
    },
  });
  const place = tools.get("inkbox_place_call");
  await assert.rejects(
    run(place, { toNumber: "2025550102", purpose: "Confirm" }),
    /E\.164/,
  );
  assert.equal(asked.length, 0);
  const output = await run(place, {
    toNumber: "+12025550102",
    purpose: "Confirm the appointment",
    openingMessage: "Hi, this is the scheduling assistant.",
    context: "The appointment is Tuesday at 3.",
    origination: "dedicated_number",
  });
  assert.match(output, /call-1/);
  assert.match(output, /when the call ends/);
  assert.equal(asked[0].title, "inkbox_place_call");
  assert.deepEqual(asked[0].patterns, ["+12025550102"]);
  assert.ok(asked[0].message.includes("Confirm the appointment"));
  assert.deepEqual(placed, [
    {
      toNumber: "+12025550102",
      mode: "hosted_agent",
      reason:
        "Confirm the appointment\n\nOpen the call with: Hi, this is the scheduling assistant.\n\nBackground: The appointment is Tuesday at 3.",
      origination: "dedicated_number",
    },
  ]);

  const calls = await run(tools.get("inkbox_list_calls"), {});
  assert.match(
    calls,
    /^id=call-1 outbound with=\+12025550102 status=completed ended_by=remote started=2026-01-02T03:04:05\.000Z purpose="Confirm the appointment"$/,
  );
  assert.equal(
    await run(tools.get("inkbox_list_call_transcripts"), { callId: "call-1" }),
    "Agent: Is Tuesday still good?\nOther party: Yes, Tuesday works.",
  );
});

test("whoami reports the SMS and iMessage numbers as separate lines", async (t) => {
  const sdk = live(t);
  const whoami = async (identity) => {
    sdk.identity = { id: "identity-1", agentHandle: "pi-agent", ...identity };
    const { pi, tools } = host();
    registerInkbox(pi, profile(t, credentials));
    return JSON.parse(await run(tools.get("inkbox_whoami"), {}));
  };
  const dedicated = await whoami({
    emailAddress: "pi-agent@example.test",
    phoneNumber: { number: "+12025550101", smsStatus: "ready" },
    imessageEnabled: true,
    imessageNumber: { number: "+12025550199" },
    whatsappEnabled: false,
  });
  assert.equal(dedicated.handle, "pi-agent");
  assert.equal(dedicated.email, "pi-agent@example.test");
  assert.equal(dedicated.phone, "+12025550101");
  assert.equal(dedicated.smsStatus, "ready");
  assert.equal(dedicated.imessageNumber, "+12025550199");
  assert.equal(dedicated.whatsappNumber, null);
  assert.deepEqual(Object.keys(dedicated.lines).sort(), [
    "imessage",
    "phone",
    "whatsapp",
  ]);
  assert.match(dedicated.lines.phone, /sms/i);
  assert.match(dedicated.lines.imessage, /separate/i);
  assert.match(dedicated.lines.whatsapp, /not enabled/i);

  const shared = await whoami({ imessageEnabled: true, whatsappEnabled: true });
  assert.equal(shared.email, null);
  assert.equal(shared.phone, null);
  assert.equal(shared.imessageNumber, null);
  assert.match(shared.lines.phone, /no sms number/i);
  assert.match(shared.lines.imessage, /shared/i);
  assert.match(shared.lines.whatsapp, /shared/i);
});

test("a gateway confirmation hook replaces the terminal dialog, and local attachments still send", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "inkbox-pi-attach-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  writeFileSync(join(directory, "notes.txt"), "hello");
  const sent = [];
  live(t).identity = {
    id: "identity-1",
    agentHandle: "pi-agent",
    sendEmail: async (message) => {
      sent.push(message);
      return { id: "mail-1" };
    },
  };
  const requests = [];
  let approve = false;
  const { pi, tools, commands } = host();
  registerInkbox(pi, profile(t, credentials), {
    confirm: async (ctx, request, signal) => {
      requests.push({ ctx, request, signal });
      return approve;
    },
  });
  // Terminal commands belong to the interactive extension only.
  assert.equal(commands.size, 0);
  const ctx = session({
    cwd: directory,
    hasUI: true,
    ui: { confirm: async () => assert.fail("Unexpected terminal dialog") },
  });
  const { signal } = new AbortController();
  const send = tools.get("inkbox_send_email");
  const args = {
    to: ["first@example.com"],
    cc: ["second@example.com"],
    subject: "Notes",
    attachmentPaths: ["notes.txt"],
  };
  await assert.rejects(run(send, args, ctx, signal), /not approved/);
  assert.equal(sent.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].ctx, ctx);
  assert.equal(requests[0].signal, signal);
  assert.equal(requests[0].request.title, "inkbox_send_email");
  assert.deepEqual(requests[0].request.patterns, [
    "first@example.com",
    "second@example.com",
  ]);
  for (const part of [
    "Notes",
    "first@example.com",
    "second@example.com",
    "notes.txt",
  ])
    assert.ok(requests[0].request.message.includes(part), part);

  approve = true;
  assert.match(await run(send, args, ctx, signal), /mail-1/);
  assert.equal(requests.length, 2);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["first@example.com"]);
  assert.equal(sent[0].attachments[0].filename, "notes.txt");
  assert.equal(
    sent[0].attachments[0].contentBase64,
    Buffer.from("hello").toString("base64"),
  );
});

test("trusting Inkbox tools skips the question in the terminal and in a gateway turn, not the recipient rules", async (t) => {
  const sent = [];
  live(t).identity = {
    id: "identity-1",
    agentHandle: "pi-agent",
    sendEmail: async (message) => {
      sent.push(message);
      return { id: "mail-" + (sent.length + 1) };
    },
  };
  const args = {
    to: ["first@example.com"],
    subject: "Notes",
    bodyText: "Hello",
  };
  const trusted = { ...credentials, autoApproveInkboxTools: true };

  const terminal = host();
  registerInkbox(terminal.pi, profile(t, trusted));
  const ctx = session({
    hasUI: true,
    ui: { confirm: async () => assert.fail("Unexpected terminal dialog") },
  });
  await run(terminal.tools.get("inkbox_send_email"), args, ctx);
  assert.equal(sent.length, 1);
  assert.equal(
    JSON.parse(await run(terminal.tools.get("inkbox_doctor"), {}))
      .inkboxToolsAutoApproved,
    true,
  );

  const turn = host();
  registerInkbox(turn.pi, profile(t, trusted), {
    confirm: async () => assert.fail("Unexpected question in the conversation"),
  });
  await run(turn.tools.get("inkbox_send_email"), args);
  assert.equal(sent.length, 2);

  const bounded = host();
  registerInkbox(
    bounded.pi,
    profile(t, {
      ...trusted,
      outbound: { allowedRecipients: ["owner@example.com"] },
    }),
  );
  await assert.rejects(
    run(bounded.tools.get("inkbox_send_email"), args, ctx),
    /allowlist/,
  );
  assert.equal(sent.length, 2);

  // Without the setting the default is still to ask.
  const asking = host();
  registerInkbox(asking.pi, profile(t, credentials));
  assert.equal(
    JSON.parse(await run(asking.tools.get("inkbox_doctor"), {}))
      .inkboxToolsAutoApproved,
    false,
  );
  await assert.rejects(
    run(asking.tools.get("inkbox_send_email"), args),
    /not approved/,
  );
  assert.equal(sent.length, 2);
});

test("a gateway turn has the diagnostics, bound to the identity the gateway verified", async (t) => {
  live(t).identity = {
    id: "identity-1",
    agentHandle: "pi-agent",
    imessageEnabled: false,
    whatsappEnabled: false,
  };
  const turn = (expectedIdentityId) => {
    const registered = host();
    registerInkbox(
      registered.pi,
      profile(t, { ...credentials, expectedIdentityId }),
      { confirm: async () => false },
    );
    return registered;
  };
  const { tools, commands } = turn("identity-1");
  assert.equal(commands.size, 0);
  const status = JSON.parse(await run(tools.get("inkbox_doctor"), {}));
  assert.equal(status.credentialConfigured, true);
  for (const name of ["inkbox_doctor", "inkbox_whoami"]) {
    assert.ok(tools.has(name), name);
    assert.ok(status.enabledTools.includes(name), name);
  }
  const identity = JSON.parse(await run(tools.get("inkbox_whoami"), {}));
  assert.equal(identity.id, "identity-1");
  assert.equal(identity.handle, "pi-agent");
  await assert.rejects(
    run(turn("identity-2").tools.get("inkbox_whoami"), {}),
    /identity changed/i,
  );
});

test("a gateway turn asks the conversation before other Pi tools and outbound sends", async (t) => {
  const { pi, tools, commands, handlers } = host();
  const asked = [];
  let answer = "deny";
  const ctx = session({
    hasUI: true,
    ui: {
      confirm: async () => assert.fail("Unexpected terminal dialog"),
      input: async (title, request) => {
        asked.push({ title, ...JSON.parse(request) });
        return answer;
      },
    },
  });
  t.after(() => delete process.env.INKBOX_PI_TURN);
  // Loaded any other way, nothing would gate Pi's own tools.
  delete process.env.INKBOX_PI_TURN;
  assert.throws(() => gatewayTurn(host().pi));
  const turnSettings = (autoAllowedTools) =>
    JSON.stringify({
      context: "Channel guidance",
      autoAllowedTools,
      profile: profile(t),
    });
  process.env.INKBOX_PI_TURN = turnSettings(["read"]);
  gatewayTurn(pi);
  // The turn settings carry the account key; commands the agent runs must not inherit them.
  assert.equal(process.env.INKBOX_PI_TURN, undefined);
  assert.equal(commands.size, 0);
  assert.ok(tools.has("inkbox_send_email"));

  const gate = handlers.get("tool_call");
  for (const call of [
    { toolName: "read", input: { path: "README.md" } },
    { toolName: "inkbox_list_emails", input: {} },
  ])
    assert.equal(await gate(call, ctx), undefined, call.toolName);
  assert.deepEqual(asked, []);

  const command = { toolName: "bash", input: { command: "npm test" } };
  const blocked = await gate(command, ctx);
  assert.equal(blocked.block, true);
  assert.equal(typeof blocked.reason, "string");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, PERMISSION_TITLE);
  assert.equal(asked[0].key, "bash");
  assert.match(asked[0].summary, /npm test/);
  answer = "allow";
  assert.equal(await gate(command, ctx), undefined);
  assert.equal(asked.length, 2);
  // The person is shown everything a tool without its own wording would receive.
  const long = "x".repeat(2000);
  await gate({ toolName: "fetch", input: { url: long } }, ctx);
  assert.equal(asked.length, 3);
  assert.equal(asked[2].key, "fetch");
  assert.ok(asked[2].summary.includes(long));

  // An unanswered question is not an approval.
  answer = "timeout";
  await assert.rejects(
    run(
      tools.get("inkbox_send_email"),
      { to: ["recipient@example.com"], subject: "hi" },
      ctx,
    ),
    /not approved/,
  );
  assert.equal(asked.length, 4);
  assert.equal(asked[3].title, PERMISSION_TITLE);
  assert.match(asked[3].key, /^inkbox_send_email\b/);
  assert.ok(asked[3].key.includes("recipient@example.com"));
  assert.ok(asked[3].summary.includes("recipient@example.com"));

  const started = handlers.get("before_agent_start")(
    { systemPrompt: "Base prompt" },
    { model: { provider: "provider", id: "model" } },
  );
  assert.ok(started.systemPrompt.startsWith("Base prompt"));
  assert.ok(started.systemPrompt.includes("Channel guidance"));
  assert.ok(started.systemPrompt.includes("provider/model"));

  // With an empty list, as when nobody can approve, even a read asks first.
  const unattended = host();
  process.env.INKBOX_PI_TURN = turnSettings([]);
  gatewayTurn(unattended.pi);
  answer = "deny";
  const read = await unattended.handlers.get("tool_call")(
    { toolName: "read", input: { path: "README.md" } },
    ctx,
  );
  assert.equal(read.block, true);
  assert.equal(asked.length, 5);
  assert.equal(asked[4].key, "read");
});

test("sensitive tools can only be enabled by exact name", () => {
  const sensitive = {
    name: "inkbox_credentials_get_login",
    group: "vault",
    defaultEnabled: false,
    sensitive: true,
  };
  assert.equal(
    isToolEnabled(sensitive, new Set(["all", "vault"]), new Set()),
    false,
  );
  assert.equal(
    isToolEnabled(sensitive, new Set([sensitive.name]), new Set()),
    true,
  );
  assert.equal(
    isToolEnabled(
      sensitive,
      new Set([sensitive.name]),
      new Set([sensitive.name]),
    ),
    false,
  );
});

test("each recipient is checked, even in automatic mode", async () => {
  const outbound = {
    approval: "auto",
    allowedRecipients: ["owner@example.com"],
  };
  await assert.rejects(
    () =>
      approveOutbound(
        {},
        { outbound },
        {
          tool: "inkbox_send_email",
          summary: "send",
          recipients: ["owner@example.com", "other@example.com"],
        },
      ),
    /allowlist/,
  );
  await assert.rejects(
    () =>
      approveOutbound(
        {},
        { outbound },
        {
          tool: "inkbox_send_sms",
          summary: "send",
          recipients: [],
          patterns: ["conversation"],
        },
      ),
    /allowlist/,
  );
});

test("WhatsApp passes the owned attachment and idempotency key through to the SDK", async () => {
  let sent;
  const tools = whatsappTools({
    config: { outbound: { approval: "auto", allowedRecipients: [] } },
    runtime: {
      getIdentity: async () => ({
        sendWhatsApp: async (options) => {
          sent = options;
          return { id: "receipt" };
        },
      }),
    },
  });
  const send = tools.find((t) => t.name === "inkbox_send_whatsapp");
  const sendFrom = (sessionID, idempotencyKey?) => send.definition.execute(
    { to: "+12025550123", mediaId: "media-1", idempotencyKey },
    { sessionID, callId: "pi-turn-1" },
  );
  await sendFrom("session-A");
  const originalKey = sent.idempotencyKey;
  assert.match(originalKey, /^pi:[0-9a-f]{64}$/);
  await sendFrom("session-A");
  assert.deepEqual(sent, {
    to: "+12025550123",
    mediaIds: ["media-1"],
    idempotencyKey: originalKey,
  });
  await sendFrom("session-B");
  assert.notEqual(sent.idempotencyKey, originalKey);
  await sendFrom("session-B", originalKey);
  assert.equal(sent.idempotencyKey, originalKey);
});
