import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInkbox } from "../extension/index.ts";
import { PERMISSION_TITLE, permissionRequest } from "./pi-rpc.js";

type Ui = {
  input(
    title: string,
    placeholder?: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
};

function describeCall(name: string, input: Record<string, unknown>): string {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  if (name === "bash") return "run the command: " + text(input.command);
  if (name === "write")
    return "create or overwrite the file " + text(input.path);
  if (name === "edit") return "edit the file " + text(input.path);
  return "use " + name + " with " + JSON.stringify(input);
}

// Loaded only into a Pi process the gateway starts for one incoming event.
export default function gatewayTurn(pi: ExtensionAPI) {
  const raw = process.env.INKBOX_PI_TURN;
  // Without the turn description nothing would gate Pi's own tools.
  if (!raw)
    throw new Error("This extension is loaded only by the Inkbox gateway.");
  // Keep the turn description out of the environment of commands the agent runs.
  delete process.env.INKBOX_PI_TURN;
  const turn = JSON.parse(raw) as {
    context: string;
    autoAllowedTools: string[];
    profile: Parameters<typeof registerInkbox>[1] | null;
  };
  const ask = async (
    ui: Ui,
    key: string,
    summary: string,
    signal?: AbortSignal,
  ) =>
    (await ui.input(PERMISSION_TITLE, permissionRequest(key, summary), {
      signal,
    })) === "allow";

  if (turn.profile) {
    registerInkbox(pi, turn.profile, {
      confirm: (ctx, request, signal) =>
        ask(
          ctx.ui,
          [request.title, ...[...(request.patterns ?? [])].sort()].join(" "),
          "use " + request.title + ": " + request.message,
          signal,
        ),
    });
    const automatic = new Set(turn.autoAllowedTools);
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName.startsWith("inkbox_") || automatic.has(event.toolName))
        return;
      if (
        await ask(
          ctx.ui,
          event.toolName,
          describeCall(event.toolName, event.input as Record<string, unknown>),
          ctx.signal,
        )
      )
        return;
      return {
        block: true,
        reason:
          "The person in this conversation did not approve this action. Do not retry it unless they ask.",
      };
    });
  }
  // Append to Pi's resolved prompt so its own instructions and persona stay intact.
  pi.on("before_agent_start", (event, ctx) => {
    const model = ctx.model;
    const selected =
      model?.provider && model.id
        ? "\nCurrent model: " + model.provider + "/" + model.id
        : "";
    return {
      systemPrompt: event.systemPrompt + "\n\n" + turn.context + selected,
    };
  });
}
