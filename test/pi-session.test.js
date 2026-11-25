import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

import {
  nativePhoneFixture,
  smsFixture,
  emailFixture,
  slackFixture,
} from "./fixtures/project-peers.js";

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
    for (const request of modelRequests) {
      const instructions = JSON.stringify(
        request.messages.filter((m) =>
          ["developer", "system"].includes(m.role),
        ),
      );
      assert.match(instructions, /coding assistant running inside pi/i);
      assert.match(instructions, /Your Inkbox handle: @fixture/);
      assert.match(instructions, /Current channel: SMS/);
      assert.match(instructions, /Your SMS number: \+12025550101/);
      assert.doesNotMatch(instructions, /first question|follow-up question/);
    }
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

// These tests stub the remote model and Inkbox network peers, not Pi, its extension,
// subprocesses, approvals, session storage or routing.
async function projectSession(t, fixture, respond, config = {}) {
  const home = mkdtempSync(join(tmpdir(), "pi-project-"));
  const workspace = join(home, "workspace");
  const agentDir = join(home, "agent");
  mkdirSync(workspace);
  mkdirSync(agentDir);
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const next = respond(requests.length - 1);
    if (typeof next === "string") {
      modelResponse(res, next);
      return;
    }
    const { name, args } = next;
    streamCompletion(res, [
      [
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_" + name,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        null,
      ],
      [{}, "tool_calls"],
    ]);
  });
  const api = "http://127.0.0.1:" + (await listen(server));
  configurePi(t, home, agentDir, api);
  writeFileSync(
    join(agentDir, "SYSTEM.md"),
    "Operator identity prompt fixture.",
  );
  writeFileSync(
    join(agentDir, "APPEND_SYSTEM.md"),
    "Operator addendum fixture.",
  );
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
      projectFiles: ["project.txt"],
      trustedConversations: fixture.grants,
      piBin: resolve("node_modules/.bin/pi"),
      ...config,
    },
    fixture,
  );
  return {
    runtime,
    workspace,
    requests,
    replies: fixture.replies,
    submit: (...args) => runtime.acceptVerified(fixture.event(...args)),
  };
}

async function until(predicate, message) {
  const deadline = Date.now() + 15_000;
  while (!predicate() && Date.now() < deadline) await delay(20);
  assert.ok(predicate(), message);
}

function command(prompt, word = "approve") {
  const match = prompt.match(
    new RegExp("/" + word + " ([a-f0-9]{24})\\b", "i"),
  );
  assert.ok(match, "Expected an explicit /" + word + " command in: " + prompt);
  return match[0];
}

const directChannels = {
  imessage: () => nativePhoneFixture("imessage"),
  whatsapp: () => nativePhoneFixture("whatsapp"),
  sms: smsFixture,
  slack: slackFixture,
  email: emailFixture,
};
for (const [channel, makeFixture] of Object.entries(directChannels))
  test(
    `real Pi edits a granted file only after approval from the original ${channel} conversation`,
    { timeout: 45_000 },
    async (t) => {
      const native = ["imessage", "whatsapp"].includes(channel);
      const fixture = makeFixture();
      const file = "project.txt";
      const finalAnswer = "I changed the status to ready.";
      const { runtime, workspace, replies, requests, submit } =
        await projectSession(
          t,
          fixture,
          (n) =>
            n === 0
              ? {
                  name: "inkbox_project_replace",
                  args: { file, oldText: "draft", newText: "ready" },
                }
              : finalAnswer,
          { slackEnabled: channel === "slack" },
        );
      const filePath = join(workspace, file);
      writeFileSync(filePath, "Status: draft\n");
      assert.equal(
        submit("edit", "owners-chat", "Please change the status to ready."),
        "accepted",
      );
      const offset = channel === "email" ? 1 : 0;
      if (channel === "email") {
        await until(() => replies.length === 1, "Missing mailbox challenge");
        assert.equal(replies[0].conversationId, "owners-chat");
        const verify = command(replies[0].text, "verify");
        assert.equal(
          requests.length,
          0,
          "No model access before mailbox possession is proven",
        );
        assert.equal(submit("foreign-verify", "other-chat", verify), "ignored");
        assert.equal(submit("verify", "owners-chat", verify), "accepted");
      }
      await until(() => replies.length > offset, "Pi did not request approval");
      const prompt = replies[offset];
      assert.equal(prompt.conversationId, "owners-chat");
      if (native) {
        assert.equal(prompt.plainReplyFallback, false);
        assert.equal(prompt.replyToMessageId, "edit");
      }
      assert.match(prompt.text, /project\.txt/);
      assert.match(prompt.text, /draft/);
      assert.match(prompt.text, /ready/);
      const approve = command(prompt.text);
      assert.match(
        JSON.stringify(requests[0].messages),
        /Please change the status to ready/,
      );
      const system = requests[0].messages.filter((m) =>
        ["developer", "system"].includes(m.role),
      );
      assert.match(JSON.stringify(system), /Operator identity prompt fixture/);
      assert.match(JSON.stringify(system), /Operator addendum fixture/);
      assert.match(JSON.stringify(system), /Current model: fixture\/fixture/);
      assert.match(
        JSON.stringify(system),
        new RegExp("Current channel: " + channel, "i"),
      );
      const tools = requests[0].tools.map((tool) => tool.function);
      assert.deepEqual(tools.map(({ name }) => name).sort(), [
        "inkbox_project_ask",
        "inkbox_project_email",
        "inkbox_project_read",
        "inkbox_project_replace",
        "inkbox_project_search",
      ]);
      for (const tool of tools.filter(({ name }) =>
        ["inkbox_project_read", "inkbox_project_replace"].includes(name),
      ))
        assert.deepEqual(tool.parameters.properties.file.enum, [file]);
      assert.equal(readFileSync(filePath, "utf8"), "Status: draft\n");

      // Even a different granted chat with the exact command cannot release the edit.
      assert.equal(submit("foreign", "other-chat", approve), "ignored");
      assert.equal(runtime.eventState("foreign"), "unknown");
      const stale = approve.slice(0, -1) + (approve.endsWith("0") ? "1" : "0");
      assert.equal(submit("stale", "owners-chat", stale), "ignored");
      assert.equal(runtime.eventState("stale"), "unknown");
      assert.equal(readFileSync(filePath, "utf8"), "Status: draft\n");
      assert.equal(requests.length, 1);
      assert.equal(
        submit(
          "approved",
          "owners-chat",
          approve,
          ["whatsapp", "slack"].includes(channel) ? "edit" : undefined,
        ),
        "accepted",
      );
      await until(
        () => runtime.eventState("edit") === "done",
        "The approved Pi turn never completed",
      );
      assert.equal(runtime.eventState("approved"), "done");
      assert.equal(readFileSync(filePath, "utf8"), "Status: ready\n");
      assert.equal(requests.length, 2);
      const result = requests[1].messages.find((m) => m.role === "tool");
      assert.ok(result);
      assert.equal(result.tool_call_id, "call_inkbox_project_replace");
      assert.match(JSON.stringify(result.content), /File updated\./);
      assert.notEqual(prompt.idempotencyKey, replies.at(-1).idempotencyKey);
      assert.deepEqual(
        replies
          .slice(offset)
          .map(({ conversationId, text }) => [conversationId, text]),
        [
          ["owners-chat", prompt.text],
          ["owners-chat", finalAnswer],
        ],
      );
    },
  );

for (const [channel, makeFixture] of Object.entries(directChannels))
  test(
    `real Pi investigates, tests, asks and emails the approved result via ${channel}`,
    { timeout: 75_000 },
    async (t) => {
      const fixture = makeFixture();
      const { identity, replies } = fixture;
      const emails = [];
      identity.mailbox ??= {
        id: "mailbox",
        emailAddress: "agent@example.test",
      };
      const replyByEmail = identity.sendEmail?.bind(identity);
      identity.sendEmail = async (message) => {
        if (message.inReplyToMessageId) return replyByEmail(message);
        emails.push(message);
        return { id: "outbound-" + emails.length, status: "sent" };
      };
      const file = "project.txt";
      const source = "src/check.js";
      const recipient = "release@example.test",
        subject = "Project check",
        body = "The release fixture passed.";
      const question = "Who should receive the release check?";
      const reply = "Please send it to release@example.test.";
      const final = "I tested the project and emailed the approved result.";
      const actions = [
        { name: "inkbox_project_search", args: { query: "release fixture" } },
        { name: "inkbox_project_read", args: { file: source } },
        { name: "inkbox_project_test", args: {} },
        { name: "inkbox_project_ask", args: { question } },
        { name: "inkbox_project_email", args: { recipient, subject, body } },
      ];
      const { workspace, runtime, requests, submit } = await projectSession(
        t,
        fixture,
        (n) => actions[n] ?? final,
        {
          // The owner configures the exact test. Pi supplies no arguments.
          slackEnabled: channel === "slack",
          projectReadWorkspace: true,
          projectTestCommand: ["node", source],
        },
      );
      mkdirSync(join(workspace, "src"));
      writeFileSync(
        join(workspace, source),
        [
          "// release fixture: hydrate inputs",
          'const assert = require("node:assert/strict");',
          'const value = require("node:fs").readFileSync("project.txt", "utf8").trim();',
          'assert.equal(value, "release fixture passed");',
          "console.log(value.toUpperCase());",
        ].join("\n"),
      );
      execFileSync("/usr/bin/git", ["init", "--quiet", workspace]);
      execFileSync("/usr/bin/git", ["-C", workspace, "add", "--", source]);
      writeFileSync(join(workspace, file), "release fixture passed\n");
      assert.equal(
        submit(
          "work",
          "owners-chat",
          "Investigate the release fixture, run its test, and ask where to send the result.",
        ),
        "accepted",
      );
      const offset = channel === "email" ? 1 : 0;
      if (offset) {
        await until(
          () => replies.length === 1,
          "Expected a mailbox proof before the model was contacted",
        );
        assert.equal(requests.length, 0);
        assert.equal(
          submit("proof", "owners-chat", command(replies[0].text, "verify")),
          "accepted",
        );
      }
      await until(
        () => replies.length >= 1 + offset,
        "The gateway did not ask to run the configured test",
      );
      assert.match(replies[offset].text, /node/);
      assert.match(replies[offset].text, /src\/check\.js/);
      assert.equal(requests.length, 3);
      const toolOutput = (requestIndex, tool) => {
        const result = requests[requestIndex].messages.find(
          (m) => m.role === "tool" && m.tool_call_id === "call_" + tool,
        );
        assert.ok(result, "Missing real Pi result for " + tool);
        return typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content);
      };
      assert.match(toolOutput(1, "inkbox_project_search"), /src\/check\.js/);
      assert.match(
        toolOutput(2, "inkbox_project_read"),
        /release fixture: hydrate inputs/,
      );
      assert.equal(emails.length, 0);
      const approveTest = command(replies[offset].text);
      assert.equal(
        submit("approve-test", "owners-chat", approveTest),
        "accepted",
      );

      await until(
        () => replies.length >= 2 + offset,
        "Pi did not forward its follow-up question",
      );
      assert.match(
        replies[offset + 1].text,
        /Who should receive the release check\?/,
      );
      assert.equal(requests.length, 4);
      const testResult = toolOutput(3, "inkbox_project_test");
      assert.match(testResult, /exit 0/);
      assert.match(testResult, /RELEASE FIXTURE PASSED/);
      const answer = command(replies[offset + 1].text, "answer") + " " + reply;
      assert.equal(submit("foreign-answer", "other-chat", answer), "ignored");
      assert.equal(submit("answer", "owners-chat", answer), "accepted");

      await until(
        () => replies.length >= 3 + offset,
        "Pi did not request approval of the exact email",
      );
      assert.equal(requests.length, 5);
      assert.ok(toolOutput(4, "inkbox_project_ask").includes(reply));
      for (const detail of [recipient, subject, body])
        assert.ok(replies[offset + 2].text.includes(detail));
      assert.equal(emails.length, 0);
      const approveEmail = command(replies[offset + 2].text);
      assert.notEqual(approveEmail, approveTest);
      assert.equal(
        submit("reused-token", "owners-chat", approveTest),
        "ignored",
      );
      assert.equal(
        submit("approve-email", "owners-chat", approveEmail),
        "accepted",
      );

      await until(
        () => runtime.eventState("work") === "done",
        "The requester did not receive Pi's completion",
      );
      assert.equal(requests.length, 6);
      assert.match(toolOutput(5, "inkbox_project_email"), /Email sent\./);
      assert.equal(emails.length, 1);
      const { idempotencyKey, ...sent } = emails[0];
      assert.ok(idempotencyKey);
      assert.deepEqual(sent, { to: [recipient], subject, bodyText: body });
      assert.equal(replies.length, 4 + offset);
      assert.ok(replies.every((r) => r.conversationId === "owners-chat"));
      assert.equal(replies.at(-1).text, final);
    },
  );
