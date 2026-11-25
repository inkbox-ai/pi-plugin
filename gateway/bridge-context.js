import { IDENTITY_LOOKUP_TITLE } from "./pi-rpc.js";
// Let Pi resolve its base prompt and operator addenda before adding routing context.
export default function register(pi) {
  const bridge = process.env.INKBOX_PI_BRIDGE_CONTEXT;
  if (!bridge) return;
  const diagnostics = JSON.parse(process.env.INKBOX_PI_DIAGNOSTICS || "[]");
  for (const name of diagnostics) {
    const identity = name === "inkbox_whoami";
    pi.registerTool({
      name,
      label: identity ? "Check Inkbox identity" : "Inspect this Pi turn",
      description: identity
        ? "Look up this agent’s current Inkbox messaging channels and assigned numbers."
        : "List the actual tools, harness and model active in this conversation.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_id, _args, signal, _update, ctx) {
        const text = identity
          ? await ctx.ui.input(IDENTITY_LOOKUP_TITLE, "", { signal })
          : JSON.stringify({
              harness: "Pi",
              provider: ctx.model?.provider,
              model: ctx.model?.id,
              tools: pi.getActiveTools(),
            });
        if (!text) throw new Error("Live identity lookup unavailable.");
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }
  pi.on("before_agent_start", (event, ctx) => {
    const model = ctx.model;
    const selected =
      model?.provider && model.id
        ? "\nCurrent model: " + model.provider + "/" + model.id
        : "";
    return { systemPrompt: event.systemPrompt + "\n\n" + bridge + selected };
  });
}
