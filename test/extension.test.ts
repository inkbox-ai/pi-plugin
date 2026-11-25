import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import inkbox from "../extension/index.ts";
import { approveOutbound } from "../extension/permissions.ts";
import { isToolEnabled } from "../extension/selection.js";
import { whatsappTools } from "../extension/tools/whatsapp.ts";

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

    ])
      assert(tools.has(name), name);
    assert(!tools.has("inkbox_slack_search"));
    assert(!tools.has("inkbox_credentials_get_secret"));
    assert(!tools.has("inkbox_place_call"));
    assert(!tools.has("inkbox_list_call_transcripts"));
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
  } finally {
    if (previous === undefined) delete process.env.INKBOX_PI_HOME;
    else process.env.INKBOX_PI_HOME = previous;
    rmSync(home, { force: true, recursive: true });
  }
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
