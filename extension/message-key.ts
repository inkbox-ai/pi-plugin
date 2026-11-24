import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "./tools/types.ts";

export const idempotencyKey = z.string().min(1).max(255)
  .regex(/^[\x20-\x7e]+$/).refine(value => Boolean(value.trim()))
  .describe("Use the original key when retrying an uncertain send; never use a fresh key for a retry.").optional();

export function requestKey(context: ToolContext, supplied?: string): string {
  if (supplied !== undefined) return supplied;
  if (!context.callId || !context.sessionID) throw new Error("Missing a stable Pi tool-call identity.");
  return "pi:" + createHash("sha256").update(JSON.stringify([context.sessionID, context.callId])).digest("hex");
}
