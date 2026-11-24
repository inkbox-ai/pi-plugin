import { createServer } from "node:http";
import { once } from "node:events";
import { verifyWebhook } from "@inkbox/sdk";
import { connect } from "@inkbox/sdk/tunnels/connect";
import { InvalidExternalEvent } from "./external.js";
import { createClient, verifiedIdentity } from "../cli/setup.js";
import { subscribe } from "./channels.js";
import { createGatewayRuntime } from "./runtime.js";
export { createGatewayRuntime };

const BODY_LIMIT = 2 * 1024 * 1024;

export function webhookHandler(signingKey, acceptVerified) {
  return async (req, res) => {
    const end = (code) => {
      res.writeHead(code);
      res.end();
    };
    if (req.url === "/health" && req.method === "GET") return end(200);
    if (req.url?.split("?")[0] !== "/webhook") return end(404);
    if (req.method !== "POST") return end(405);
    let chunks = [],
      length = 0;
    try {
      for await (const chunk of req) {
        length += chunk.length;
        if (length > BODY_LIMIT) return end(413);
        chunks.push(chunk);
      }
      const payload = Buffer.concat(chunks);
      let verified = false;
      try {
        const timestamp = req.headers["x-inkbox-timestamp"];
        verified =
          Boolean(signingKey && req.headers["x-inkbox-request-id"]) &&
          /^\d+$/.test(timestamp) &&
          Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300 &&
          verifyWebhook({ payload, headers: req.headers, secret: signingKey });
      } catch {
        /* Invalid signatures fail closed. */
      }
      if (!verified) return end(401);
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        return end(400);
      }
      if (
        typeof event?.id !== "string" ||
        !event.id ||
        typeof event.event_type !== "string"
      )
        return end(400);
      acceptVerified(event);
      end(202);
    } catch (error) {
      if (!res.headersSent)
        end(error instanceof InvalidExternalEvent ? 400 : 503);
    }
  };
}

export async function startGateway(config) {
  if (!config.signingKey || !config.apiKey || !config.identity)
    throw new Error("Run inkbox-pi setup before starting the gateway.");
  if (
    config.publicUrl &&
    (!config.port || !/^https:\/\//i.test(config.publicUrl))
  ) {
    throw new Error("A public URL needs HTTPS and a fixed local port.");
  }
  const client = createClient(config.apiKey, config.baseUrl);
  const identity = await verifiedIdentity(client, config.identity);
  const runtime = createGatewayRuntime(config, { client, identity });
  const server = createServer(
    webhookHandler(config.signingKey, runtime.acceptVerified),
  );
  server.requestTimeout = 15_000;
  let listener,
    closeTask,
    stopping = false;
  async function cleanup() {
    stopping = true;
    try {
      await listener?.close();
    } finally {
      if (server.listening) {
        const ended = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await ended;
      }
      await runtime.close();
    }
  }
  function close() {
    return (closeTask ??= cleanup());
  }
  try {
    server.listen(config.port ?? 0, "127.0.0.1");
    await once(server, "listening");
    let publicUrl = config.publicUrl;
    let failed = runtime.failed;
    if (!publicUrl) {
      const connected = Promise.withResolvers();
      listener = await connect(client, {
        name: config.tunnelName || identity.agentHandle,
        forwardTo: "http://127.0.0.1:" + server.address().port,
        installSignalHandlers: false,
        onStatus(status) {
          if (status === "connected") connected.resolve();
        },
      });
      const served = listener.wait().then(() => {
        if (!stopping) throw new Error("The Inkbox tunnel closed.");
      });
      failed = Promise.race([served, runtime.failed]);
      failed.catch(() => {});
      const timeout = setTimeout(
        () =>
          connected.reject(new Error("Inkbox tunnel connection timed out.")),
        15_000,
      );
      try {
        await Promise.race([connected.promise, failed]);
      } finally {
        clearTimeout(timeout);
      }
      publicUrl = listener.publicUrl;
    }
    const webhook = new URL("/webhook", publicUrl).href;
    await subscribe(client, identity, webhook);
    return { publicUrl, failed, close };
  } catch (error) {
    await close();
    throw error;
  }
}
