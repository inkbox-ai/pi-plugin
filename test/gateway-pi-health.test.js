import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { A2A_RESPONSE_INSTRUCTIONS } from "../extension/a2a-outcome.js";
import { DEFAULT_AUTO_ALLOWED_TOOLS, runPiTurn } from "../gateway/pi.js";
import { checkPiModel, restricted, turnFlags } from "../gateway/preflight.js";
import { frameInbound, systemContext } from "../gateway/prompts.js";
import { failureCategory, startupProblem } from "../gateway/diagnostics.js";
import { boundedReply } from "../gateway/reply-limits.js";

async function executable(t, source) {
  const dir = await mkdtemp(join(tmpdir(), "pi-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "pi.cjs");
  await writeFile(file, "#!/usr/bin/env node\n" + source, { mode: 0o700 });
  return { piBin: file, projectDirectory: dir };
}
// A stand-in for Pi's RPC mode: read the prompt, print the records chosen for
// it, and exit once the gateway closes stdin.
function rpcFixture(records) {
  return `
    const accepted = (prompt) => ({ type: "response", id: prompt.id, command: "prompt", success: true, data: { disposition: "started" } });
    const settled = { type: "agent_settled" };
    let input = "", answered = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (answered || !input.includes("\\n")) return;
      answered = true;
      const prompt = JSON.parse(input.slice(0, input.indexOf("\\n")));
      for (const record of (${records})(prompt, accepted(prompt), settled))
        console.log(JSON.stringify(record));
    });
  `;
}
const assistant = (stopReason, text) => ({
  type: "message_end",
  message: {
    role: "assistant",
    stopReason,
    content: [{ type: "text", text }],
    errorMessage: "authorization test: invalid API key: secret-fixture",
  },
});
const smsRoute = { channel: "sms", sender: "contact", text: "hello" };
async function run(t, source, route = smsRoute) {
  const config = await executable(t, source);
  return runPiTurn(
    config,
    route,
    join(config.projectDirectory, "session.jsonl"),
    new AbortController().signal,
  );
}
function transcript(t, reasons) {
  const messages = reasons.map((stopReason) =>
    assistant(stopReason, stopReason === "stop" ? "complete" : "partial"),
  );
  return run(
    t,
    rpcFixture(
      "(prompt, accepted, settled) => [accepted, ..." +
        JSON.stringify(messages) +
        ", settled]",
    ),
  );
}
test("a person's turn that ends without text sends nothing; an agent task still needs an outcome", async (t) => {
  const silent = rpcFixture(
    "(prompt, accepted, settled) => [accepted, " +
      JSON.stringify(assistant("stop", "  ")) +
      ", settled]",
  );
  assert.equal(await run(t, silent), "[SILENT]");
  await assert.rejects(
    run(t, silent, { channel: "a2a", sender: "peer", text: "task" }),
    (error) => error.category === "pi-incomplete",
  );
});
// The fixture answers with what Pi was started with and the prompt it was sent.
async function launch(t, config, route, askPermission) {
  const fixture = await executable(
    t,
    rpcFixture(`(prompt, accepted, settled) => [accepted, {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify({
          args: process.argv.slice(2),
          turn: JSON.parse(process.env.INKBOX_PI_TURN),
          inkboxEnv: Object.keys(process.env).filter((name) => name.startsWith("INKBOX_")),
          prompt: prompt.message,
        }) }],
      },
    }, settled]`),
  );
  const session = join(fixture.projectDirectory, "session.jsonl");
  const seen = JSON.parse(
    await runPiTurn(
      { ...config, ...fixture },
      route,
      session,
      new AbortController().signal,
      askPermission,
    ),
  );
  return { ...seen, session };
}
// Someone in the conversation can be asked; an agent task has nobody.
const attended = async () => "reject";
const unattended = Object.assign(async () => "reject", { unattended: true });

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
        // The turn had started: it must not be run again.
        error.started !== false &&
        !String(error).includes("secret-fixture"),
    );
  }
});
test("a messaging turn starts Pi with its tools, skills and one-time turn settings", async (t) => {
  const saved = process.env.INKBOX_API_KEY;
  process.env.INKBOX_API_KEY = "ambient-fixture";
  t.after(() => {
    if (saved === undefined) delete process.env.INKBOX_API_KEY;
    else process.env.INKBOX_API_KEY = saved;
  });
  const config = {
    apiKey: "turn-fixture",
    baseUrl: "https://example.com",
    identity: "fixture",
    identityId: "agent-id",
    home: "/profile",
    tools: { disable: ["inkbox_place_call"] },
    outbound: { approval: "ask" },
    slackEnabled: false,
    handle: "fixture",
    smsNumber: "+12025550101",
  };
  const route = {
    channel: "sms",
    sender: "+12025550102",
    conversation: "conversation",
    text: "hello",
    contact: { id: "contact-1", name: "Alex" },
    memories: ["Prefers short answers."],
  };
  const seen = await launch(t, config, route, attended);
  assert.deepEqual(seen.args.slice(0, 2), ["--mode", "rpc"]);
  const skill = seen.args.indexOf("--skill");
  assert.ok(skill > 0 && /skills$/.test(seen.args[skill + 1]));
  // Pi's own tools are added to whatever the resumed session had selected.
  const tools = seen.args[seen.args.indexOf("--tools") + 1].split(",");
  assert.ok(seen.args.includes("--tools"));
  assert.ok(tools.every((name) => name.startsWith("+")));
  for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"])
    assert.ok(tools.includes("+" + name), name);
  for (const flag of turnFlags) assert.ok(seen.args.includes(flag), flag);
  for (const flag of ["--no-tools", "--no-skills", "--no-context-files"])
    assert.ok(!seen.args.includes(flag), flag);
  const [extensionFlag, extension, sessionFlag, session] = seen.args.slice(-4);
  assert.deepEqual([extensionFlag, sessionFlag], ["-e", "--session"]);
  assert.match(extension, /turn-extension\.ts$/);
  assert.equal(session, seen.session);
  // Only the turn settings cross into Pi's environment.
  assert.deepEqual(seen.inkboxEnv, ["INKBOX_PI_TURN"]);
  assert.deepEqual(seen.turn, {
    context: systemContext(config, route),
    autoAllowedTools: DEFAULT_AUTO_ALLOWED_TOOLS,
    profile: {
      apiKey: "turn-fixture",
      baseUrl: "https://example.com",
      identity: "fixture",
      expectedIdentityId: "agent-id",
      home: "/profile",
      tools: { disable: ["inkbox_place_call"] },
      outbound: { approval: "ask" },
      slackEnabled: false,
      signingKeyConfigured: false,
    },
  });
  assert.equal(seen.prompt, frameInbound(route));
  assert.match(seen.prompt, /^\[inkbox:sms from=\+12025550102 /);

  const configured = await launch(
    t,
    { ...config, autoAllowedTools: ["read"] },
    route,
    attended,
  );
  assert.deepEqual(configured.turn.autoAllowedTools, ["read"]);
});
test("with nobody to ask, no Pi tool runs unasked", async (t) => {
  const config = { identity: "fixture", autoAllowedTools: ["read", "bash"] };
  const task = {
    channel: "a2a",
    sender: "peer",
    conversation: "task",
    text: "Do it",
  };
  const agentTask = await launch(t, config, task, unattended);
  assert.deepEqual(agentTask.turn.autoAllowedTools, []);
  assert.equal(
    agentTask.turn.context,
    systemContext(config, task) + "\n\n" + A2A_RESPONSE_INSTRUCTIONS,
  );
  assert.equal(agentTask.prompt, frameInbound(task));
  const noCallback = await launch(t, config, { ...smsRoute });
  assert.deepEqual(noCallback.turn.autoAllowedTools, []);
});
test("an external event still runs Pi without tools, skills, context files or an account profile", async (t) => {
  const route = {
    channel: "external",
    sender: "source",
    text: '{"body":"data"}',
  };
  const seen = await launch(
    t,
    { apiKey: "turn-fixture", identity: "fixture" },
    route,
    unattended,
  );
  assert.deepEqual(seen.args.slice(0, 3), ["--mode", "rpc", "--no-tools"]);
  for (const flag of restricted) assert.ok(seen.args.includes(flag), flag);
  assert.ok(!seen.args.includes("--skill"));
  assert.ok(!seen.args.includes("--tools"));
  assert.equal(seen.turn.profile, null);
  assert.deepEqual(seen.turn.autoAllowedTools, []);
  assert.match(seen.turn.context, /untrusted data/);
  assert.doesNotMatch(JSON.stringify(seen.turn), /turn-fixture/);
  assert.equal(seen.prompt, route.text);
});
test("a Pi process that exits before accepting the prompt can be retried; its stderr is kept for the operator log", async (t) => {
  await assert.rejects(
    run(
      t,
      `process.stdin.once("data", () =>
        process.stderr.write("extension failed to load\\n", () => process.exit(1)),
      );`,
    ),
    (error) =>
      error.category === "pi-incomplete" &&
      error.started === false &&
      error.detail === "extension failed to load" &&
      !String(error).includes("extension failed to load"),
  );
});
function refusal(t, error) {
  return run(
    t,
    rpcFixture(
      "(prompt) => [{ type: 'response', id: prompt.id, command: 'prompt', success: false, error: " +
        JSON.stringify(error) +
        " }]",
    ),
  );
}
test("a prompt that Pi refuses never started, so the turn can be retried", async (t) => {
  await assert.rejects(
    refusal(t, "The agent is busy: secret-fixture"),
    (error) =>
      error.category === "pi-protocol" &&
      error.started === false &&
      !String(error).includes("secret-fixture"),
  );
});
test("a prompt refused for missing model credentials is reported as a credential problem", async (t) => {
  await assert.rejects(
    refusal(t, "No API key found for the selected provider: secret-fixture"),
    (error) =>
      error.category === "pi-auth" &&
      error.started === false &&
      !String(error).includes("secret-fixture"),
  );
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

test("automatic Slack replies format links and bold without touching inline code", () => {
  assert.equal(
    boundedReply("slack", "**Hello**, [docs](https://example.com) and `**x**`"),
    "*Hello*, <https://example.com|docs> and `**x**`",
  );
});
