// Resolve the published package subpath just as a TypeScript adapter would.
import type { AgentIdentity, Inkbox, TextWebhookPayload } from "@inkbox/sdk";
import { createGatewayRuntime, type GatewayConfig, type EventState } from "@inkbox/pi-plugin/runtime";

// What an embedding application can set for the tools and approvals of a turn.
export const turnOptions = {
  apiKey: "key",
  autoAllowedTools: ["read", "grep"],
  permissionTimeoutS: 120,
  contactMemories: false,
  outbound: { approval: "ask", allowedRecipients: ["owner@example.com"] },
} satisfies Partial<GatewayConfig>;

export const started: EventState = "running";

export function adapter(config: GatewayConfig, client: Inkbox, identity: AgentIdentity) {
  const runtime = createGatewayRuntime({ ...config, ...turnOptions }, { client, identity });
  return {
    accept(event: TextWebhookPayload): EventState {
      runtime.acceptVerified(event);
      return runtime.eventState(event.id);
    },
    stop: () => runtime.close(),
  };
}
