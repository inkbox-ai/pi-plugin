import test from "node:test";
import assert from "node:assert/strict";
import { remoteTools } from "../extension/tools/remote.ts";

test("remote executor cannot bypass disabled native tools or expose calling", async () => {
  const deps = { runtime: { getClient() { throw new Error("unexpected network access"); } } } as any;
  const locals = [{ name: "inkbox_list_contacts", group: "contacts", defaultEnabled: true }] as any;
  const tools = remoteTools(deps, locals, { enable: ["all"], disable: ["inkbox_list_contacts"] });
  const call = tools.find(tool => tool.name === "inkbox_remote_call")!;
  for (const name of ["inkbox_contacts_list", "inkbox_call_place", "inkbox_identity_switch"]) {
    await assert.rejects(call.definition.execute({name, arguments: {}}, {} as any), /not enabled/);
  }
});
