import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createGatewayRuntime, startGateway } from "../gateway/index.js";

const identity = {
  id: "agent",
  agent_handle: "fixture",
  organization_id: "organization",
  phone_number: { id: "phone", number: "+12025550101" },
};

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function streamCompletion(res, chunks) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of chunks) {
    res.write(
      "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          model: "fixture",
          created: 1,
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n",
    );
  }
  res.end("data: [DONE]\n\n");
}

function modelResponse(res, text) {
  streamCompletion(res, [
    [{ role: "assistant", content: text }, null],
    [{}, "stop"],
  ]);
}

function configurePi(t, home, agentDir, api) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: api + "/v1",
          apiKey: "fixture",
          api: "openai-completions",
          models: [{ id: "fixture" }],
        },
      },
    }),
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }),
  );
  t.after(() => {
    for (const key of ["HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

// Exercise raw webhook -> durable inbox -> real Pi -> real Inkbox SDK -> reply.
// Only the network peers are fixtures; no credentials or live delivery are needed.
test(
  "signed SMS resumes Pi across gateway restarts and replies exactly once to its source",
  { timeout: 45_000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "pi-conversation-"));
    const workspace = join(home, "workspace");
    const agentDir = join(home, "agent");
    mkdirSync(workspace);
    mkdirSync(agentDir);
    const modelRequests = [],
      replies = [],
      subscriptions = [];
    let sent = Promise.withResolvers();
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw && JSON.parse(raw);
      function json(value, status = 200) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      }
      if (url.pathname === "/v1/chat/completions") {
        modelRequests.push(body);
        modelResponse(
          res,
          modelRequests.length === 1 ? "first answer" : "second answer",
        );
      } else if (req.headers["x-api-key"] !== "fixture") json({}, 401);
      else if (url.pathname === "/api/whoami")
        json({
          auth_type: "api_key",
          auth_subtype: "api_key.agent_scoped.claimed",
        });
      else if (
        url.pathname === "/api/v1/identities/" ||
        url.pathname === "/api/v1/identities"
      )
        json([identity]);
      else if (url.pathname === "/api/v1/identities/fixture") json(identity);
      else if (url.pathname === "/api/v1/identities/fixture/signing-key")
        json({ configured: true });
      else if (
        url.pathname === "/api/v1/phone/numbers/phone/texts/conversations"
      )
        json([
          {
            id: "conversation",
            is_group: false,
            remote_phone_number: "+12025550102",
            participants: ["+12025550102"],
          },
        ]);
      else if (url.pathname === "/api/v1/webhooks/catalog")
        json({ supports_identity_subscriptions: true });
      else if (
        url.pathname === "/api/v1/webhooks/subscriptions" &&
        req.method === "GET"
      ) {
        json({
          subscriptions: subscriptions.filter((row) =>
            ["phone_number_id", "agent_identity_id", "url"].every(
              (key) =>
                !url.searchParams.has(key) ||
                row[key] === url.searchParams.get(key),
            ),
          ),
        });
      } else if (
        url.pathname === "/api/v1/webhooks/subscriptions" &&
        req.method === "POST"
      ) {
        const row = {
          ...body,
          id: "sub-" + subscriptions.length,
          status: "active",
        };
        subscriptions.push(row);
        json(row, 201);
      } else if (
        url.pathname === "/api/v1/phone/numbers/phone/texts" &&
        req.method === "POST"
      ) {
        replies.push({ ...body, key: req.headers["idempotency-key"] });
        json({ id: "reply-" + replies.length, direction: "outbound", ...body });
        sent.resolve();
      } else
        json(
          {
            detail:
              "Unexpected fixture request: " + req.method + " " + url.pathname,
          },
          404,
        );
    });
    const api = "http://127.0.0.1:" + (await listen(server));
    configurePi(t, home, agentDir, api);
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    const config = {
      home,
      identity: "fixture",
      apiKey: "fixture",
      signingKey: "test-signing-key",
      projectDirectory: workspace,
      piBin: resolve("node_modules/.bin/pi"),
      baseUrl: api,
      publicUrl: "https://gateway.example.test",
      port,
    };
    let gateway;
    t.after(async () => {
      await gateway?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { force: true, recursive: true });
    });
    async function deliver(id, text) {
      const body = JSON.stringify({
        id: "event-" + id,
        event_type: "text.received",
        data: {
          text_message: {
            id,
            direction: "inbound",
            sender_access: "direct",
            conversation_id: "conversation",
            sender_phone_number: "+12025550102",
            local_phone_number: identity.phone_number.number,
            text,
          },
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", config.signingKey)
        .update(id + "." + timestamp + "." + body)
        .digest("hex");
      const response = await fetch("http://127.0.0.1:" + port + "/webhook", {
        method: "POST",
        body,
        headers: {
          "x-inkbox-timestamp": timestamp,
          "x-inkbox-request-id": id,
          "x-inkbox-signature": "sha256=" + signature,
        },
      });
      assert.equal(response.status, 202);
    }
    gateway = await startGateway(config);
    await deliver("first", "first question");
    await sent.promise;
    await gateway.close();
    gateway = await startGateway(config);
    sent = Promise.withResolvers();
    await deliver("first", "first question"); // retry after restart must not wake the model
    await deliver("second", "follow-up question");
    await sent.promise;
    assert.equal(modelRequests.length, 2);
    assert.match(JSON.stringify(modelRequests[1].messages), /first answer/);
    assert.match(
      JSON.stringify(modelRequests[1].messages),
      /follow-up question/,
    );
    assert.deepEqual(modelRequests[1].tools ?? [], []);
    assert.deepEqual(
      replies.map((r) => [r.conversation_id, r.text]),
      [
        ["conversation", "first answer"],
        ["conversation", "second answer"],
      ],
    );
    assert.ok(
      replies[0].key && replies[1].key && replies[0].key !== replies[1].key,
    );
    assert.ok(
      subscriptions.some((row) => row.event_types.includes("text.received")),
    );
  },
);

test(
  "real Pi edits a granted file only after approval from the original iMessage conversation",
  { timeout: 45_000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "pi-project-approval-"));
    const workspace = join(home, "workspace");
    const agentDir = join(home, "agent");
    mkdirSync(workspace);
    mkdirSync(agentDir);
    const file = "project.txt";
    const filePath = join(workspace, file);
    writeFileSync(filePath, "Status: draft\n");
    const modelRequests = [];
    const finalAnswer = "I changed the status to ready.";
    const server = createServer(async (req, res) => {
      if (req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      modelRequests.push(JSON.parse(body));
      if (modelRequests.length === 1) {
        streamCompletion(res, [
          [
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_replace",
                  type: "function",
                  function: {
                    name: "inkbox_project_replace",
                    arguments: JSON.stringify({
                      file,
                      oldText: "draft",
                      newText: "ready",
                    }),
                  },
                },
              ],
            },
            null,
          ],
          [{}, "tool_calls"],
        ]);
      } else {
        modelResponse(res, finalAnswer);
      }
    });
    const api = "http://127.0.0.1:" + (await listen(server));
    configurePi(t, home, agentDir, api);

    const owner = "+12025550102",
      other = "+12025550103";
    const sources = new Map();
    const peers = { "owners-chat": owner, "other-chat": other };
    const replies = [];
    const identity = {
      id: "agent",
      imessageEnabled: true,
      imessageNumber: { number: "+12025550101" },
      async getIMessage(id) {
        return sources.get(id);
      },
      async getIMessageConversation(id) {
        const peer = peers[id];
        return {
          id,
          isGroup: false,
          remoteNumber: peer,
          participants: [peer],
          assignmentId: null,
        };
      },
      async sendIMessage(message) {
        replies.push(message);
        return { id: "reply-" + replies.length };
      },
    };
    let runtime;
    t.after(async () => {
      await runtime?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    });
    runtime = createGatewayRuntime(
      {
        home,
        projectDirectory: workspace,
        baseUrl: api,
        projectFiles: [file],
        trustedConversations: Object.entries(peers).map(
          ([chat, peer]) => "imessage:" + chat + ":" + peer,
        ),
        piBin: resolve("node_modules/.bin/pi"),
      },
      { client: {}, identity },
    );

    function submit(id, chat, text, threadRoot) {
      const peer = peers[chat];
      sources.set(id, {
        id,
        conversationId: chat,
        threadRootMessageId: threadRoot,
        direction: "inbound",
        service: "imessage",
        isGroup: false,
        isBlocked: false,
        remoteNumber: peer,
        participants: [peer],
        assignmentId: null,
        content: text,
      });
      return runtime.acceptVerified({
        id,
        event_type: "imessage.received",
        data: {
          message: {
            id,
            conversation_id: chat,
            thread_root_message_id: threadRoot,
            remote_number: peer,
            direction: "inbound",
            sender_access: "direct",
            content: text,
          },
        },
      });
    }
    async function until(predicate, message) {
      const deadline = Date.now() + 15_000;
      while (!predicate() && Date.now() < deadline) await delay(20);
      assert.ok(predicate(), message);
    }

    const original = "Please change the status to ready.";
    assert.equal(submit("edit", "owners-chat", original), "accepted");
    await until(() => replies.length > 0, "Pi did not request approval");
    assert.equal(replies[0].conversationId, "owners-chat");
    assert.equal(replies[0].plainReplyFallback, false);
    assert.equal(replies[0].replyToMessageId, "edit");
    assert.match(replies[0].text, /project\.txt/);
    assert.match(replies[0].text, /draft/);
    assert.match(replies[0].text, /ready/);
    const approval = replies[0].text.match(/\/approve ([a-f0-9]{24})\b/i);
    assert.ok(approval, "Expected an explicit approval command");
    assert.match(
      JSON.stringify(modelRequests[0].messages),
      /Please change the status to ready/,
    );
    const tools = modelRequests[0].tools.map((tool) => tool.function);
    assert.deepEqual(tools.map(({ name }) => name).sort(), [
      "inkbox_project_read",
      "inkbox_project_replace",
    ]);
    for (const tool of tools)
      assert.deepEqual(tool.parameters.properties.file.enum, [file]);
    assert.equal(readFileSync(filePath, "utf8"), "Status: draft\n");

    // Even a different owner-granted chat with the exact command cannot release the edit.
    assert.equal(submit("foreign", "other-chat", approval[0]), "ignored");
    assert.equal(runtime.eventState("foreign"), "unknown");
    const staleCode =
      (approval[1][0] === "0" ? "1" : "0") + approval[1].slice(1);
    assert.equal(
      submit("stale", "owners-chat", "/approve " + staleCode),
      "ignored",
    );
    assert.equal(runtime.eventState("stale"), "unknown");
    assert.equal(readFileSync(filePath, "utf8"), "Status: draft\n");
    assert.equal(modelRequests.length, 1);
    assert.equal(
      submit("approved", "owners-chat", approval[0], "edit"),
      "accepted",
    );
    await until(
      () => runtime.eventState("edit") === "done",
      "The approved Pi turn never completed",
    );
    assert.equal(runtime.eventState("approved"), "done");
    assert.equal(readFileSync(filePath, "utf8"), "Status: ready\n");
    assert.equal(modelRequests.length, 2);
    const toolResult = modelRequests[1].messages.find(
      (message) => message.role === "tool",
    );
    assert.ok(toolResult, "Pi must have executed the real tool");
    assert.equal(toolResult.tool_call_id, "call_replace");
    assert.match(JSON.stringify(toolResult.content), /File updated\./);
    assert.notEqual(replies[0].idempotencyKey, replies[1].idempotencyKey);
    assert.deepEqual(
      replies.map(({ conversationId, text }) => [conversationId, text]),
      [
        ["owners-chat", replies[0].text],
        ["owners-chat", finalAnswer],
      ],
    );
  },
);
