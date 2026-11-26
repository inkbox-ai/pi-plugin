import type { AgentIdentity, Inkbox } from "@inkbox/sdk";
import type { RequestListener } from "node:http";

export interface GatewayConfig {
  /** Private, persistent directory. Only one runtime may own an identity here. */
  home: string;
  baseUrl: string;
  projectDirectory: string;
  piBin?: string;
  slackEnabled?: boolean;
  groupReplyMode?: "auto" | "mention";
  companionResponseMode?: "safe" | "relaxed";
  allowedSenders?: string[];
  tools?: { enable?: string[]; disable?: string[] };
  outbound?: { approval?: "ask" | "allowlist" | "auto"; allowedRecipients?: string[] };
  /** Account key the turn's Inkbox tools act with. */
  apiKey?: string;
  /** Run Inkbox tools without the per-call question. Pi's own tools still ask. Default: false. */
  autoApproveInkboxTools?: boolean;
  /** Run every tool in a messaging turn without asking anyone. Default: false. */
  yolo?: boolean;
  /** Pi tools that run without asking the conversation. Default: read, grep, find, ls. */
  autoAllowedTools?: string[];
  /** How long an approval question waits for an answer. Default: 600. */
  permissionTimeoutS?: number;
  /** Include the sender's Inkbox contact memories in the turn. Default: true. */
  contactMemories?: boolean;
}

export interface ListenerConfig extends GatewayConfig {
  identity: string;
  apiKey: string;
  signingKey: string;
  publicUrl?: string;
  port?: number;
  tunnelName?: string;
}

export interface VerifiedEvent {
  id: string;
  event_type: string;
  data: unknown;
  companion?: unknown;
}

export type EventState =
  | "unknown" | "queued" | "running" | "reply" | "report" | "sending"
  | "done" | "ignored" | "failed" | "uncertain" | "canceled";

export interface GatewayRuntime {
  /** The owning adapter must verify the event before admission. */
  acceptVerified(event: VerifiedEvent): "accepted" | "duplicate" | "ignored";
  eventState(eventId: string): EventState;
  lastFailure(eventId: string): { category: string; attempt: number } | null;
  eventResult(eventId: string): string | null;
  failed: Promise<never>;
  close(): Promise<void>;
}

export function createGatewayRuntime(
  config: GatewayConfig,
  dependencies: { client: Inkbox; identity: AgentIdentity; logger?: Pick<Console, "error"> },
): GatewayRuntime;

export function webhookHandler(signingKey: string, acceptVerified: (event: VerifiedEvent) => unknown): RequestListener;

export function startGateway(config: ListenerConfig): Promise<{
  publicUrl: string;
  failed: Promise<void>;
  close(): Promise<void>;
}>;
