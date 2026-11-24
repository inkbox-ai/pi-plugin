import { createRequire } from "node:module";
import { Inkbox, type AgentIdentity } from "@inkbox/sdk";
import { verifiedIdentity } from "../cli/setup.js";

export type InkboxRuntime = ReturnType<typeof createInkboxRuntime>;

export function createInkboxRuntime(config: {
  apiKey?: string;
  baseUrl?: string;
  identity?: string;
}) {
  let client: Inkbox | undefined;
  function getClient() {
    if (!config.apiKey || !config.identity)
      throw new Error("Run inkbox-pi setup first.");
    if (!client) {
      const version = createRequire(import.meta.url)("../package.json").version;
      client = new Inkbox({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        userAgentPrefix: "inkbox-pi/" + version,
      });
      // A separate vault unlock key is optional; tools handle vault access on demand.
      void client.ready().catch(() => {});
    }
    return client;
  }
  let verified: Promise<AgentIdentity> | undefined;
  function getIdentity(): Promise<AgentIdentity> {
    if (!verified) {
      verified = verifiedIdentity(getClient(), config.identity).catch(
        (error: unknown) => {
          verified = undefined;
          throw error;
        },
      );
    }
    return verified!;
  }
  return {
    getIdentity,
    getClient: async () => {
      await getIdentity();
      return getClient();
    },
  };
}
