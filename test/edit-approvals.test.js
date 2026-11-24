import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createEditApprovals } from "../gateway/approvals.js";
import { createGatewayRuntime } from "../gateway/runtime.js";

const sender = "+12025550121";
const proposal = {
  file: "example.txt",
  oldText: "old\n\u202e",
  newText: "*new*",
};

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "pi-edit-approval-"));
  const config = {
    home,
    projectDirectory: home,
    projectFiles: [proposal.file],
    trustedConversations: ["imessage:room:" + sender],
  };
  const sources = new Map();
  const identity = {
    id: "identity",
    imessageEnabled: true,
    imessageNumber: { number: "+12025550100" },
    getIMessage: async (id) => sources.get(id),
    getIMessageConversation: async (id) => ({
      id,
      remoteNumber: sender,
      participants: [sender],
      assignmentId: null,
      isGroup: false,
    }),
  };
  const prompt = Promise.withResolvers();
  const delivery = Promise.withResolvers();
  const result = Promise.withResolvers();
  const turns = [];
  let runtime;

  function open() {
    runtime = createGatewayRuntime(config, {
      client: {},
      identity,
      async turn(_config, route, file, signal, confirmEdit) {
        turns.push(route.message);
        const confirmed = await confirmEdit(proposal);
        result.resolve(confirmed);
        if (!signal.aborted) await writeFile(file, "transcript");
        return confirmed ? "allowed" : "not allowed";
      },
      async reply(_route, text) {
        if (!text.includes("/approve ")) return;
        prompt.resolve(text);
        return delivery.promise;
      },
    });
  }
  function submit(id, text, { sourceText = text, record = {} } = {}) {
    sources.set(id, {
      id,
      conversationId: "room",
      direction: "inbound",
      service: "imessage",
      isGroup: false,
      isBlocked: false,
      remoteNumber: sender,
      participants: [sender],
      assignmentId: null,
      content: sourceText,
    });
    return runtime.acceptVerified({
      id,
      event_type: "imessage.received",
      data: {
        message: {
          id,
          content: text,
          conversation_id: "room",
          remote_number: sender,
          direction: "inbound",
          sender_access: "direct",
          ...record,
        },
      },
    });
  }
  async function until(id, state) {
    for (let i = 0; i < 500; i++) {
      if (runtime.eventState(id) === state) return;
      await delay(10);
    }
    assert.fail(
      id + ": expected " + state + " but got " + runtime.eventState(id),
    );
  }
  open();
  t.after(async () => {
    delivery.resolve();
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  });
  const restart = async () => {
    await runtime.close();
    open();
  };
  return {
    submit,
    until,
    sources,
    prompt,
    delivery,
    result,
    turns,
    restart,
    config,
  };
}

test(
  "only the exact edit and the owner-authenticated control may complete the waiting turn",
  { timeout: 12000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal(f.submit("work", "fix it"), "accepted");
    const prompt = await f.prompt.promise;
    const approve = prompt.match(/\/approve [0-9a-f]{24}/)[0];
    const displayed = prompt.split("\n")[1];
    assert.deepEqual(JSON.parse(displayed), proposal);
    assert.ok(!displayed.includes("\u202e") && !displayed.includes("*"));

    for (const [id, record] of Object.entries({
      foreign: { remote_number: "+12025550122" },
      thread: { thread_id: "other" },
      assignment: { assignment_id: "other" },
      group: { is_group: true },
    }))
      assert.equal(f.submit(id, approve, { record }), "ignored");
    assert.equal(f.submit("wrong-code", "/approve 000"), "ignored");
    assert.equal(
      f.submit("forged", approve, { sourceText: "ordinary text" }),
      "accepted",
    );
    await f.until("forged", "ignored");
    assert.equal(f.submit("approved", approve), "accepted");
    await f.until("approved", "done");
    assert.equal(
      f.submit("second-decision", approve.replace("/approve", "/deny")),
      "ignored",
    );
    // An early, real decision is insufficient when its prompt has not finished sending.
    const sentinel = Symbol();
    assert.equal(
      await Promise.race([f.result.promise, delay(10, sentinel)]),
      sentinel,
    );
    f.delivery.resolve();
    assert.equal(await f.result.promise, true);
    await f.until("work", "done");
    assert.equal(f.submit("replay", approve), "ignored");
    assert.deepEqual(f.turns, ["work"]);
  },
);

test(
  "a prompt delivery failure, revoked grant, changed source or explicit denial cannot approve",
  { timeout: 15000 },
  async (t) => {
    for (const cause of [
      "send failure",
      "file grant",
      "original source",
      "decision source",
      "deny",
    ]) {
      await t.test(cause, async (t) => {
        const f = await fixture(t);
        f.submit("work", "fix it");
        const prompt = await f.prompt.promise;
        const approve = prompt.match(/\/approve [0-9a-f]{24}/)[0];
        const command =
          cause === "deny" ? approve.replace("/approve", "/deny") : approve;
        f.submit("control", command);
        await f.until("control", "done");
        if (cause === "send failure")
          f.delivery.reject(new Error("unknown delivery outcome"));
        else if (cause === "file grant") f.config.projectFiles = ["other.txt"];
        else if (cause === "original source")
          f.sources.get("work").isBlocked = true;
        else if (cause === "decision source")
          f.sources.get("control").content = "changed";
        f.delivery.resolve();
        assert.equal(await f.result.promise, false);
        assert.deepEqual(f.turns, ["work"]);
      });
    }
  },
);

test(
  "a verified stop cancels a pending approval; a disguised stale control never reaches Pi",
  { timeout: 8000 },
  async (t) => {
    const f = await fixture(t);
    f.submit("hidden", "normal webhook text", { sourceText: "/approve stale" });
    await f.until("hidden", "ignored");
    f.submit("work", "fix it");
    const command = (await f.prompt.promise).match(/\/approve [0-9a-f]{24}/)[0];
    f.delivery.resolve();
    f.submit("stop", "/stop");
    await f.until("stop", "done");
    assert.equal(await f.result.promise, false);
    await f.until("work", "uncertain");
    assert.equal(f.submit("after-stop", command), "ignored");
    assert.deepEqual(f.turns, ["work"]);
  },
);

test(
  "a restart denies the open edit, never starts its turn again, and drops the old code",
  { timeout: 6000 },
  async (t) => {
    const f = await fixture(t);
    f.submit("work", "fix it");
    const command = (await f.prompt.promise).match(/\/approve [0-9a-f]{24}/)[0];
    f.delivery.resolve();
    await f.restart();
    assert.equal(await f.result.promise, false);
    await f.until("work", "uncertain");
    assert.equal(f.submit("late", command), "ignored");
    assert.deepEqual(f.turns, ["work"]);
  },
);

test("a timed-out prompt and a host cancellation settle even when delivery never returns", async (t) => {
  for (const cause of ["deadline", "host exit"]) {
    await t.test(cause, async (t) => {
      const timeout = new AbortController();
      const host = new AbortController();
      t.mock.method(AbortSignal, "timeout", (ms) => {
        assert.equal(ms, 120000);
        return timeout.signal;
      });
      const registry = createEditApprovals();
      const route = { thread: "room", projectGrant: "revision", sender };
      const prompt = Promise.withResolvers();
      const untilSend = Promise.withResolvers();
      const request = {
        route,
        proposal,
        signal: host.signal,
        verify: async () => true,
        send: async (msg) => {
          prompt.resolve(msg);
          return untilSend.promise;
        },
      };
      const result = registry.request(request);
      const command = (await prompt.promise).match(/\/approve [0-9a-f]{24}/)[0];
      assert.equal(await registry.request(request), false);
      (cause === "deadline" ? timeout : host).abort();
      assert.equal(await result, false);
      assert.equal(registry.consume(route, command), false);
      untilSend.resolve();
    });
  }
});
