import type { ZodType } from "zod";
import type { InkboxRuntime } from "../client.ts";
import type { VaultRuntime } from "../vault.ts";

export interface ToolContext {
  callId: string;
  sessionID: string;
  abort?: AbortSignal;
  directory: string;
  confirm(title: string, message: string): Promise<boolean>;
}
export interface ToolDeps {
  runtime: InkboxRuntime;
  vault: VaultRuntime;
  config: {
    home: string;
    slackEnabled: boolean;
    outbound: {
      approval: "auto" | "ask" | "allowlist";
      allowedRecipients: string[];
    };
  };
}
export interface RegisteredTool {
  name: string;
  group: string;
  defaultEnabled: boolean;
  sensitive?: boolean;
  definition: {
    description: string;
    args: Record<string, ZodType>;
    execute(
      args: any,
      ctx: ToolContext,
    ): Promise<string | { title?: string; output: string }>;
  };
}
