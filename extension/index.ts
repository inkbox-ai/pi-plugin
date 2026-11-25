import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { loadConfig } from "../cli/config.js";
import { createInkboxRuntime } from "./client.ts";
import { createVaultRuntime } from "./vault.ts";
import { isToolEnabled } from "./selection.js";
import { a2aTools } from "./tools/a2a.ts";
import { accessTools } from "./tools/access.ts";
import { contactRuleTools } from "./tools/contact-rules.ts";
import { contactTools } from "./tools/contacts.ts";
import { emailReadTools } from "./tools/email-reads.ts";
import { forwardEmailTools } from "./tools/forward-email.ts";
import { imessageReadTools } from "./tools/imessage-reads.ts";
import { noteTools } from "./tools/notes.ts";
import { remoteTools } from "./tools/remote.ts";
import { sendEmailTools } from "./tools/send-email.ts";
import { sendIMessageTools } from "./tools/send-imessage.ts";
import { sendSmsTools } from "./tools/send-sms.ts";
import { slackTools } from "./tools/slack.ts";
import { smsReadTools } from "./tools/sms-reads.ts";
import { vaultTools } from "./tools/vault.ts";
import { whatsappTools } from "./tools/whatsapp.ts";
import type { RegisteredTool, ToolDeps } from "./tools/types.ts";

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || !v.trim())
  )
    throw new Error(field + " must be an array of nonempty strings.");
  return value;
}

function policy(value: unknown): ToolDeps["config"]["outbound"]["approval"] {
  if (value === undefined) return "ask";
  if (value !== "ask" && value !== "allowlist" && value !== "auto")
    throw new Error("Invalid outbound.approval.");
  return value;
}

export default function inkbox(pi: ExtensionAPI) {
  const config = loadConfig();
  const runtime = createInkboxRuntime(config);
  const deps: ToolDeps = {
    runtime,
    vault: createVaultRuntime(runtime),
    config: {
      ...config,
      outbound: {
        approval: policy(config.outbound?.approval),
        allowedRecipients: stringList(
          config.outbound?.allowedRecipients,
          "outbound.allowedRecipients",
        ),
      },
    },
  };
  const selection = {
    enable: stringList(config.tools?.enable, "tools.enable"),
    disable: stringList(config.tools?.disable, "tools.disable"),
  };
  const enabled = new Set(selection.enable),
    disabled = new Set(selection.disable);
  const local = [
    a2aTools,
    accessTools,
    contactRuleTools,
    contactTools,
    emailReadTools,
    forwardEmailTools,
    imessageReadTools,
    noteTools,
    sendEmailTools,
    sendIMessageTools,
    sendSmsTools,
    slackTools,
    smsReadTools,
    vaultTools,
    whatsappTools,
  ].flatMap((build) => build(deps));
  const status = () => ({
    identity: config.identity || null,
    credentialConfigured: Boolean(config.apiKey),
    gatewaySigningKeyConfigured: Boolean(config.signingKey),
    outboundApproval: deps.config.outbound.approval,
    enabledTools: tools
      .filter((t) => isToolEnabled(t, enabled, disabled))
      .map((t) => t.name),
    disabledTools: tools
      .filter((t) => !isToolEnabled(t, enabled, disabled))
      .map((t) => t.name),
  });
  local.push(
    {
      name: "inkbox_doctor",
      group: "diagnostics",
      defaultEnabled: true,
      definition: {
        args: {},
        description:
          "Show configuration status and enabled tools without displaying credentials.",
        execute: async () => JSON.stringify(status()),
      },
    },
    {
      name: "inkbox_whoami",
      group: "diagnostics",
      defaultEnabled: true,
      definition: {
        args: {},
        description:
          "Verify the active Inkbox identity, email, phone number and iMessage availability.",
        execute: async () => {
          const identity = await runtime.getIdentity();
          return JSON.stringify({
            id: identity.id,
            handle: identity.agentHandle,
            email: identity.mailbox?.emailAddress,
            phone: identity.phoneNumber?.number,
            imessageEnabled: identity.imessageEnabled,
            whatsappEnabled: identity.whatsappEnabled,
          });
        },
      },
    },
  );
  const tools: RegisteredTool[] = [
    ...local,
    ...remoteTools(deps, local, selection),
  ];
  for (const tool of tools) {
    if (!isToolEnabled(tool, enabled, disabled)) continue;
    const schema = z.strictObject(tool.definition.args);
    // Pi's tool validator accepts JSON Schema. Validate again with Zod for refinements
    // (e.g. Unicode text lengths) that don't have a JSON Schema representation.
    const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema, {
      target: "draft-7",
      io: "input",
    });
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.definition.description,
      parameters: parameters as Parameters<
        ExtensionAPI["registerTool"]
      >[0]["parameters"],
      async execute(callId, args, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const result = await tool.definition.execute(schema.parse(args), {
          callId,
          sessionID: ctx.sessionManager.getSessionId(),
          directory: ctx.cwd,
          abort: signal,
          confirm: async (title, message) =>
            ctx.hasUI && (await ctx.ui.confirm(title, message, { signal })),
        });
        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : result.output,
            },
          ],
          details: undefined,
        };
      },
    });
  }
  pi.registerCommand("inkbox-status", {
    description: "Inspect the local Inkbox configuration",
    handler: async (_args, ctx) => {
      ctx.ui.notify(JSON.stringify(status(), null, 2), "info");
    },
  });
  pi.registerCommand("inkbox", {
    description:
      "Show setup and gateway commands for this package installation",
    handler: async (_args, ctx) => {
      const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
      const script = fileURLToPath(new URL("../bin/inkbox-pi.js", import.meta.url));
      const command = "node " + quote(script);
      ctx.ui.notify(
        [
          "Run in a separate terminal:",
          ...["setup", "doctor", "start"].map(
            (action) => command + " " + action,
          ),
        ].join("\n"),
        "info",
      );
    },
  });
}
