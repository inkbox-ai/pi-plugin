import type { ToolContext, ToolDeps } from "./tools/types.ts";

export async function approveOutbound(
  ctx: ToolContext,
  config: ToolDeps["config"],
  request: {
    tool: string;
    recipients: string[];
    patterns?: string[];
    summary: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  ctx.abort?.throwIfAborted();
  const { approval, allowedRecipients } = config.outbound;
  const allowed = new Set(allowedRecipients.map((v) => v.trim().toLowerCase()));
  if (approval === "allowlist" && !allowed.size)
    throw new Error("Outbound allowlist is empty.");
  if (
    allowed.size &&
    (!request.recipients.length ||
      request.recipients.some((v) => !allowed.has(v.trim().toLowerCase())))
  )
    throw new Error(
      "One or more recipients are unknown or not on the outbound allowlist.",
    );
  if (approval === "allowlist" || approval === "auto") return;
  const targets = request.recipients.length
    ? request.recipients
    : request.patterns;
  if (
    !targets?.length ||
    !(await ctx.confirm(
      request.tool,
      [
        request.summary,
        ...targets,
        ...(request.metadata ? [JSON.stringify(request.metadata)] : []),
      ].join("\n"),
    ))
  )
    throw new Error("Outbound action was not approved.");
  ctx.abort?.throwIfAborted();
}
