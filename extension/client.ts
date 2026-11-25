import { createRequire } from "node:module";
import type { Inkbox, AgentIdentity } from "@inkbox/sdk";
import { verifiedIdentity, createClient } from "../cli/setup.js";

export type InkboxRuntime = ReturnType<typeof createInkboxRuntime>;

export function createInkboxRuntime(config: {
  apiKey?: string;
  baseUrl?: string;
  identity?: string;
  expectedIdentityId?: string;
}) {
  let client: Inkbox | undefined;
  function getClient() {
    if (!config.apiKey || !config.identity)
      throw new Error("Run inkbox-pi setup first.");
    if (!client) {
      const version = createRequire(import.meta.url)("../package.json").version;
      client = createClient(
        config.apiKey,
        config.baseUrl,
        "inkbox-pi/" + version,
      );
    }
    return client;
  }
  let verified: Promise<AgentIdentity> | undefined;
  function getIdentity(): Promise<AgentIdentity> {
    if (!verified) {
      verified = verifiedIdentity(getClient(), config.identity)
        .then((identity) => {
          if (
            config.expectedIdentityId &&
            config.expectedIdentityId !== identity.id
          )
            throw new Error("The gateway identity changed.");
          return identity;
        })
        .catch((error: unknown) => {
          verified = undefined;
          throw error;
        });
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
