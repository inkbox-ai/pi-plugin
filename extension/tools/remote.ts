import { createHash } from "node:crypto";
import { join } from "node:path";
import { RemoteMcp } from "@inkbox/sdk/remote-mcp";
import { z } from "zod";
import { approveOutbound } from "../permissions.ts";
import { isToolEnabled } from "../selection.js";
import type { RegisteredTool, ToolContext, ToolDeps } from "./types.ts";

// Only relay operations with a known local policy. In particular, the generic
// executor must not turn a disabled tool or a recipient restriction into a suggestion.
const equivalents = new Map(
  Object.entries({
    inkbox_contacts_list: "inkbox_list_contacts",
    inkbox_contact_get: "inkbox_get_contact",
    inkbox_contact_create: "inkbox_create_contact",
    inkbox_contact_update: "inkbox_update_contact",
    inkbox_contact_delete: "inkbox_delete_contact",
    inkbox_notes_list: "inkbox_list_notes",
    inkbox_note_get: "inkbox_get_note",
    inkbox_note_create: "inkbox_create_note",
    inkbox_note_update: "inkbox_update_note",
    inkbox_note_delete: "inkbox_delete_note",
    inkbox_email_get: "inkbox_get_email",
    inkbox_emails_list: "inkbox_list_emails",
  }),
);

// Read-only is a property of the known operation AND the current catalog. A
// write cannot opt out of approval by advertising a readOnlyHint.
const readOnlyOperations = new Set([
  "inkbox_contacts_list",
  "inkbox_contact_get",
  "inkbox_notes_list",
  "inkbox_note_get",
  "inkbox_email_get",
  "inkbox_emails_list",
]);

export function remoteTools(
  deps: ToolDeps,
  localTools: RegisteredTool[],
  selection: { enable: string[]; disable: string[] },
): RegisteredTool[] {
  const enable = new Set(selection.enable);
  const disable = new Set(selection.disable);
  const active = new Set(
    localTools
      .filter((tool) => isToolEnabled(tool, enable, disable))
      .map((tool) => tool.name),
  );
  function allowed(name: string) {
    const local = equivalents.get(name);
    return local !== undefined && active.has(local) && !disable.has(name);
  }
  async function catalog(ctx: ToolContext) {
    ctx.abort?.throwIfAborted();
    const client = await deps.runtime.getClient();
    const account = await client.whoami();
    if (account.authSubtype !== "api_key.agent_scoped.claimed") {
      throw new Error("Remote tools require a claimed agent identity.");
    }
    const identity = await deps.runtime.getIdentity();
    const sessionHash = createHash("sha256")
      .update(ctx.sessionID)
      .digest("hex");
    const remote = new RemoteMcp({
      apiKey: client._apiKey,
      baseUrl: client._baseUrl,
      identity: identity.id,
      journalPath: join(deps.config.home, "remote-calls", sessionHash),
    });
    const tools = (await remote.refresh({ signal: ctx.abort })).filter((tool) =>
      allowed(tool.name),
    );
    return { remote, tools };
  }
  return [
    {
      name: "inkbox_remote_tools",
      group: "remote",
      defaultEnabled: true,
      definition: {
        description:
          "Discover enabled remote Inkbox operations with their exact JSON input schemas.",
        args: { name: z.string().optional() },
        async execute({ name }, ctx) {
          const { tools } = await catalog(ctx);
          return JSON.stringify(
            name ? tools.filter((tool) => tool.name === name) : tools,
          );
        },
      },
    },
    {
      name: "inkbox_remote_call",
      group: "remote",
      defaultEnabled: true,
      definition: {
        description:
          "Execute an enabled operation from inkbox_remote_tools using the discovered schema. Use channel-specific tools for sending.",
        args: {
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()),
        },
        async execute({ name, arguments: args }, ctx) {
          if (!allowed(name)) throw new Error("This operation is not enabled.");
          if (!ctx.callId || !ctx.sessionID)
            throw new Error("Missing native tool-call identity.");
          const { tools, remote } = await catalog(ctx);
          const descriptor = tools.find((tool) => tool.name === name);
          if (!descriptor)
            throw new Error("Remote operation no longer available.");
          if (readOnlyOperations.has(name)) {
            if (descriptor.annotations?.readOnlyHint !== true) {
              throw new Error(
                "The catalog does not confirm this operation is read-only.",
              );
            }
          } else {
            await approveOutbound(ctx, deps.config, {
              tool: "inkbox_remote_call",
              recipients: [],
              patterns: [name],
              summary:
                "Run remote operation with arguments: " + JSON.stringify(args),
            });
          }
          const result = await remote.call(name, args, {
            callIdentity: ctx.callId,
            signal: ctx.abort,
          });
          return JSON.stringify(result);
        },
      },
    },
  ];
}
