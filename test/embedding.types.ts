// Resolve the published package subpath just as a TypeScript adapter would.
import type { AgentIdentity, Inkbox, TextWebhookPayload } from "@inkbox/sdk";
import { createGatewayRuntime, type GatewayConfig, type EventState } from "@inkbox/pi-plugin/runtime";

export function adapter(config: GatewayConfig, client: Inkbox, identity: AgentIdentity) {
  const runtime = createGatewayRuntime(config, { client, identity });
  return {
    accept(event: TextWebhookPayload): EventState {
      runtime.acceptVerified(event);
      return runtime.eventState(event.id);
    },
    stop: () => runtime.close(),
  };
}
