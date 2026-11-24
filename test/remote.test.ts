import test from "node:test";
import assert from "node:assert/strict";
import { remoteTools } from "../extension/tools/remote.ts";

test("remote executor cannot bypass disabled native tools or expose calling", async () => {
  const deps = {
    runtime: {
      getClient() {
        throw new Error("unexpected network access");
      },
    },
  } as any;
  const locals = [
    { name: "inkbox_list_contacts", group: "contacts", defaultEnabled: true },
  ] as any;
  const tools = remoteTools(deps, locals, {
    enable: ["all"],
    disable: ["inkbox_list_contacts"],
  });
  const call = tools.find((tool) => tool.name === "inkbox_remote_call")!;
  for (const name of [
    "inkbox_contacts_list",
    "inkbox_call_place",
    "inkbox_identity_switch",
  ]) {
    await assert.rejects(
      call.definition.execute({ name, arguments: {} }, {} as any),
      /not enabled/,
    );
  }
});

test("recipient restrictions apply to remote writes, not verified local-equivalent reads", async (t) => {
  const { RemoteMcp } = await import("@inkbox/sdk/remote-mcp");
  let readOnlyHint: unknown = true;
  const descriptors = () =>
    ["inkbox_contacts_list", "inkbox_contact_create"].map((name) => ({
      name,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint },
    }));
  t.mock.method(RemoteMcp.prototype, "refresh", async () => descriptors());
  const execute = t.mock.method(RemoteMcp.prototype, "call", async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  const deps = {
    config: {
      home: ".",
      outbound: { approval: "ask", allowedRecipients: ["reader@example.com"] },
    },
    runtime: {
      getClient: async () => ({
        _baseUrl: "https://example.com",
        _apiKey: "fixture",
        whoami: async () => ({ authSubtype: "api_key.agent_scoped.claimed" }),
      }),
      getIdentity: async () => ({ id: "identity" }),
    },
  } as any;
  const local = ["inkbox_list_contacts", "inkbox_create_contact"].map(
    (name) => ({ name, group: "contacts", defaultEnabled: true }),
  ) as any;
  const registered = remoteTools(deps, local, { enable: [], disable: [] });
  const catalog = registered.find(
    (tool) => tool.name === "inkbox_remote_tools",
  )!.definition;
  const call = registered.find(
    (tool) => tool.name === "inkbox_remote_call",
  )!.definition;
  const ctx = {
    callId: "call",
    sessionID: "session",
    confirm: async () => assert.fail("Unexpected confirmation"),
  } as any;
  assert.deepEqual(
    JSON.parse((await catalog.execute({}, ctx)) as string).map(
      (t: any) => t.name,
    ),
    descriptors().map((t) => t.name),
  );
  await call.execute({ name: "inkbox_contacts_list", arguments: {} }, ctx);
  assert.equal(execute.mock.callCount(), 1);
  // Even a mislabeled write cannot escape the recipient or approval policy.
  await assert.rejects(
    call.execute({ name: "inkbox_contact_create", arguments: {} }, ctx),
    /allowlist/,
  );
  for (const hint of [false, undefined, "true"]) {
    readOnlyHint = hint;
    await assert.rejects(
      call.execute({ name: "inkbox_contacts_list", arguments: {} }, ctx),
      /does not confirm/,
    );
  }
  deps.config.outbound.allowedRecipients = [];
  const deny = t.mock.fn(async () => false);
  await assert.rejects(
    call.execute(
      { name: "inkbox_contact_create", arguments: {} },
      { ...ctx, confirm: deny },
    ),
    /not approved/,
  );
  assert.equal(deny.mock.callCount(), 1);
  assert.equal(execute.mock.callCount(), 1);
});
