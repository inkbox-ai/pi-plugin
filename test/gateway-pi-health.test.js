import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runPiTurn } from "../gateway/pi.js";
import { checkPiModel } from "../gateway/preflight.js";
import { failureCategory, startupProblem } from "../gateway/diagnostics.js";
import { boundedReply } from "../gateway/reply-limits.js";

async function executable(t, source) {
  const dir = await mkdtemp(join(tmpdir(), "pi-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "pi.cjs");
  await writeFile(file, "#!/usr/bin/env node\n" + source, { mode: 0o700 });
  return { piBin: file, projectDirectory: dir };
}
async function transcript(t, reasons) {
  const messages = reasons.map((stopReason) => ({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason,
      content: [
        { type: "text", text: stopReason === "stop" ? "complete" : "partial" },
      ],
      errorMessage: "authorization test: invalid API key: secret-fixture",
    },
  }));
  const config = await executable(
    t,
    "process.stdin.resume();\n" +
      messages
        .map((m) => "console.log(" + JSON.stringify(JSON.stringify(m)) + ");")
        .join("\n"),
  );
  return runPiTurn(
    config,
    { channel: "sms", sender: "contact", text: "hello" },
    join(config.projectDirectory, "session.jsonl"),
    new AbortController().signal,
  );
}
test("Pi can recover from an intermediate error; only the final completed answer is returned", async (t) => {
  assert.equal(await transcript(t, ["error", "toolUse", "stop"]), "complete");
});
test("incomplete/error model output is not delivered, and no private error detail surfaces", async (t) => {
  for (const [reason, category] of [
    ["length", "pi-incomplete"],
    ["aborted", "pi-incomplete"],
    ["error", "pi-auth"],
    ["toolUse", "pi-turn"],
  ]) {
    await assert.rejects(
      transcript(t, ["stop", reason]),
      (error) =>
        error.category === category &&
        !String(error).includes("secret-fixture"),
    );
  }
});
test("model preflight verifies selected provider credentials without issuing a model prompt", async (t) => {
  const config = await executable(
    t,
    `
    const args = process.argv.slice(2);
    if (args.includes("rpc")) {
      process.stdin.on("data", chunk => {
        const command = JSON.parse(chunk);
        if (command.type !== "get_state") process.exit(9);
        console.log(JSON.stringify({id:command.id,type:"response",success:true,data:{model:{id:"unit", provider:"unit"}}}));
      });
    } else if (args.join(" ") === "auth check --provider unit --json --no-refresh") console.log('{"status":"ready"}');
    else process.exit(9);
  `,
  );
  await checkPiModel(config);
});
test("missing model and missing credentials have separate actionable errors", async (t) => {
  for (const [data, category] of [
    [{}, "pi-model"],
    [{ model: { id: "unit", provider: "unit" } }, "pi-auth"],
  ]) {
    const config = await executable(
      t,
      `
      if (process.argv.includes("rpc")) process.stdin.on("data", () =>
        console.log(JSON.stringify({id:"inkbox-model",type:"response",success:true,data:${JSON.stringify(data)}})));
      else { console.error("secret-fixture"); process.exit(1); }
    `,
    );
    await assert.rejects(
      checkPiModel(config),
      (e) =>
        e.category === category &&
        e.operatorMessage &&
        !String(e).includes("secret-fixture"),
    );
  }
});
test("gateway reply limits preserve complete Unicode characters and label truncated replies", () => {
  for (const [channel, limit] of [
    ["sms", 1600],
    ["imessage", 18995],
    ["whatsapp", 4000],
    ["slack", 12000],
  ]) {
    assert.equal(boundedReply(channel, "short"), "short");
    const reply = boundedReply(channel, "🙂".repeat(limit + 1));
    assert.ok(
      reply.length <= limit &&
        reply.isWellFormed() &&
        reply.endsWith("this channel.]"),
    );
  }
});
test("operator diagnostics preserve actionable HTTP/network categories, not remote messages", () => {
  const error = Object.assign(new Error("secret-fixture"), { statusCode: 403 });
  assert.equal(failureCategory(error), "inkbox-http-403");
  assert.match(
    startupProblem("subscription setup", error).operatorMessage,
    /subscription setup.*403/,
  );
  assert.doesNotMatch(
    startupProblem("subscription setup", error).operatorMessage,
    /secret-fixture/,
  );
});

test("A2A callers without a handle remain identity-bound when progress follows their latest message", async () => {
  const { parseRoute, beforeTurn, sendReply } = await import(
    "../gateway/channels.js"
  );
  const event = {
    id: "evt-task",
    event_type: "a2a.task.created",
    data: {
      caller: { identity_id: "peer", handle: null },
      context_id: "ctx",
      task_id: "task",
      message_id: "m1",
    },
  };
  const task = {
    id: "task",
    contextId: "ctx",
    state: "working",
    caller: { identityId: "peer", handle: null },
    messages: [
      { messageId: "m1", role: "ROLE_CALLER", parts: [{ text: "question" }] },
      { messageId: "m2", role: "agent", parts: [{ text: "progress" }] },
    ],
  };
  const identity = { id: "self", a2aTask: async () => task };
  const route = parseRoute(event, identity);
  assert.equal(route.sender, "peer");
  assert.equal(await beforeTurn(route, {}, identity), true);
  task.state = "canceled";
  assert.deepEqual(await sendReply(route, "answer", "x", {}, identity), {
    skipped: true,
  });
});

test(
  "permanent HTTP failures expose a sanitized receipt and don't repeat the turn",
  { timeout: 5000 },
  async (t) => {
    const { createGatewayRuntime } = await import("../gateway/runtime.js");
    const home = await mkdtemp(join(tmpdir(), "pi-job-"));
    const logs = [],
      reported = Promise.withResolvers();
    let turns = 0;
    const runtime = createGatewayRuntime(
      { home },
      {
        identity: { id: "agent", agentHandle: "agent" },
        client: {
          inbound: {
            async reportInboundEventResult() {
              reported.resolve();
            },
          },
        },
        logger: {
          error(...args) {
            logs.push(args);
          },
        },
        async turn() {
          turns++;
          throw Object.assign(new Error("secret-fixture"), { statusCode: 403 });
        },
      },
    );
    t.after(async () => {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    });
    runtime.acceptVerified({
      id: "event",
      event_type: "inbound.received",
      data: {
        source: { id: "source", name: "source" },
        event_id: "event",
        delivery_id: "delivery",
        handler: { type: "agent" },
        request: { body: "private-body", body_encoding: "utf8" },
      },
    });
    await reported.promise;
    assert.deepEqual(
      { ...runtime.lastFailure("event") },
      { attempt: 1, category: "inkbox-http-403" },
    );
    assert.equal(turns, 1);
    assert.doesNotMatch(JSON.stringify(logs), /private-body|secret-fixture/);
  },
);
