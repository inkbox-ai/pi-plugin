import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { loadConfig } from "../cli/config.js";
import { createInkboxRuntime } from "./client.ts";
import { createVaultRuntime } from "./vault.ts";
import { isToolEnabled } from "./selection.js";
import { a2aTools } from "./tools/a2a.ts";
import { accessTools } from "./tools/access.ts";
import { callTools } from "./tools/calls.ts";
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
  registerInkbox(pi, loadConfig());
}

type ToolExecutionContext = Parameters<
  Parameters<ExtensionAPI["registerTool"]>[0]["execute"]
>[4];

// The gateway registers the same catalog for a turn it starts, and answers
// confirmations by asking the person in the conversation.
export function registerInkbox(
  pi: ExtensionAPI,
  config: ReturnType<typeof loadConfig>,
  gateway?: {
    confirm(
      ctx: ToolExecutionContext,
      request: { title: string; message: string; patterns?: string[] },
      signal?: AbortSignal,
    ): Promise<boolean>;
  },
) {
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
    callTools,
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
    gatewaySigningKeyConfigured: Boolean(
      config.signingKey ||
        (config as { signingKeyConfigured?: boolean }).signingKeyConfigured,
    ),
    outboundApproval: deps.config.outbound.approval,
    inkboxToolsAutoApproved: Boolean(config.autoApproveInkboxTools),
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
          "Show this agent's live Inkbox identity: handle, email address, SMS number, iMessage and WhatsApp numbers, and which channels are enabled.",
        execute: async () => {
          const identity = await runtime.getIdentity();
          const imessageNumber = identity.imessageNumber?.number ?? null;
          return JSON.stringify({
            id: identity.id,
            handle: identity.agentHandle,
            displayName: identity.displayName ?? null,
            email: identity.emailAddress ?? identity.mailbox?.emailAddress ?? null,
            phone: identity.phoneNumber?.number ?? null,
            smsStatus: identity.phoneNumber?.smsStatus ?? null,
            imessageEnabled: identity.imessageEnabled,
            imessageNumber,
            whatsappEnabled: identity.whatsappEnabled,
            whatsappNumber: identity.whatsappNumber ?? null,
            lines: {
              phone: identity.phoneNumber?.number
                ? "Your own number for SMS and phone calls."
                : "No SMS number is provisioned.",
              imessage: !identity.imessageEnabled
                ? "iMessage is not enabled."
                : imessageNumber
                  ? "Your own iMessage number. It is a separate line from the SMS number unless the two values are equal."
                  : "iMessage uses a shared line with no number of its own; people reach you by connecting through Inkbox.",
              whatsapp: !identity.whatsappEnabled
                ? "WhatsApp is not enabled."
                : identity.whatsappNumber
                  ? "Your own WhatsApp number."
                  : "WhatsApp uses a shared number with no number of its own.",
            },
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
      // Lists the tool in Pi's own summary of available tools.
      promptSnippet: tool.definition.description.split(/(?<=\.)\s/)[0],
      parameters: parameters as Parameters<
        ExtensionAPI["registerTool"]
      >[0]["parameters"],
      async execute(callId, args, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const parsed = schema.parse(args);
        const result = await tool.definition.execute(parsed, {
          callId,
          sessionID: ctx.sessionManager.getSessionId(),
          directory: ctx.cwd,
          abort: signal,
          confirm: async (title, message, patterns) =>
            // The operator chose to trust Inkbox tools; recipient rules still apply.
            config.autoApproveInkboxTools === true ||
            (gateway
              ? gateway.confirm(ctx, { title, message, patterns }, signal)
              : ctx.hasUI && (await ctx.ui.confirm(title, message, { signal }))),
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
  if (gateway) return;
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
