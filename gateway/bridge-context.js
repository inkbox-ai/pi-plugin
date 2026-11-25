// Let Pi resolve its base prompt and operator addenda before adding routing context.
export default function register(pi) {
  const bridge = process.env.INKBOX_PI_BRIDGE_CONTEXT;
  if (!bridge) return;
  pi.on("before_agent_start", (event, ctx) => {
    const model = ctx.model;
    const selected =
      model?.provider && model.id
        ? "\nCurrent model: " + model.provider + "/" + model.id
        : "";
    return { systemPrompt: event.systemPrompt + "\n\n" + bridge + selected };
  });
}
