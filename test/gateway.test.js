import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { webhookHandler, createGatewayRuntime } from "../gateway/index.js";
import { parseRoute, sendReply, subscribe } from "../gateway/channels.js";

const identity = {
  id: "agent-test",
  phoneNumber: { number: "+12025550101" },
  imessageEnabled: true,
  async listTextConversations() {
    return ["thread-a", "thread-b"].map((id) => ({
      id,
      isGroup: false,
      remotePhoneNumber: "+12025550102",
      participants: ["+12025550102"],
    }));
  },
};
const sms = (id, text = "Hi", conversation = "thread-a") => ({
  id: "evt-" + id,
  event_type: "text.received",
  data: {
    text_message: {
      id,
      conversation_id: conversation,
      direction: "inbound",
      text,
      sender_phone_number: "+12025550102",
      local_phone_number: identity.phoneNumber.number,
    },
  },
});

test("signed ingress rejects changed bytes before admission", async () => {
  const seen = [];
  const server = createServer(
    webhookHandler("test-secret", (event) => seen.push(event.id)),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port + "/webhook";
  const body = JSON.stringify(sms("1"));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "test-secret")
    .update("request." + timestamp + "." + body)
    .digest("hex");
  const headers = {
    "x-inkbox-signature": "sha256=" + signature,
    "x-inkbox-timestamp": timestamp,
    "x-inkbox-request-id": "request",
  };
  try {
    assert.equal(
      (await fetch(url, { method: "POST", body, headers })).status,
      202,
    );
    assert.equal(
      (await fetch(url, { method: "POST", body: body + " ", headers })).status,
      401,
    );
    assert.deepEqual(seen, ["evt-1"]);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("outbound, self, disallowed sender, STOP and other identities cannot wake Pi", () => {
  for (const change of [
    { direction: "outbound" },
    { sender_phone_number: identity.phoneNumber.number },
    { local_phone_number: "+12025550103" },
    { text: " STOP " },
    { sender_access: "sponsored" },
  ]) {
    const event = sms("1");
    Object.assign(event.data.text_message, change);
    assert.equal(parseRoute(event, identity), null);
  }
  assert.equal(parseRoute(sms("1"), identity, ["another"]), null);
  const event = sms("1");
  event.event_type = "call.ended";
  assert.equal(parseRoute(event, identity), null);
});

test("gateway durably resumes only the originating conversation and suppresses replays", async () => {
  const home = await mkdtemp(join(tmpdir(), "inkbox-pi-"));
  const received = [];
  const config = { home, baseUrl: "https://example.com" };
  let sent = Promise.withResolvers();
  const deps = {
    identity,
    client: {},
    async turn(_, route, file) {
      let lines = "";
      try {
        lines = await readFile(file, "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const answer = lines + route.text;
      await writeFile(file, answer, { mode: 0o600 });
      return answer;
    },
    async reply(route, answer, key) {
      received.push([route.conversation, answer, key]);
      sent.resolve();
    },
  };
  let runtime;
  try {
    runtime = createGatewayRuntime(config, deps);
    assert.throws(() => createGatewayRuntime(config, deps), /Another gateway/);
    runtime.acceptVerified(sms("1"));
    await sent.promise;
    await runtime.close();
    runtime = createGatewayRuntime(config, deps);
    assert.equal(runtime.acceptVerified(sms("1")), "duplicate");
    sent = Promise.withResolvers();
    runtime.acceptVerified(sms("2", "!"));
    await sent.promise;
    sent = Promise.withResolvers();
    runtime.acceptVerified(sms("3", "other", "thread-b"));
    await sent.promise;
    assert.deepEqual(
      received.map(([, text]) => text),
      ["Hi", "Hi!", "other"],
    );
    assert.notEqual(received[0][2], received[1][2]);
  } finally {
    await runtime?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("reply routing is bound to the inbound group, never model-supplied destinations", async () => {
  const route = parseRoute(sms("1"), identity);
  let sent;
  await sendReply(
    route,
    "Reply",
    "stable",
    {},
    {
      ...identity,
      async sendText(args) {
        sent = args;
      },
    },
  );
  assert.deepEqual(sent, {
    conversationId: "thread-a",
    text: "Reply",
    idempotencyKey: "stable",
  });
});

test("subscription reconciliation preserves another URL and excludes calling", async () => {
  const created = [];
  const client = {
    webhooks: {
      subscriptions: {
        async list() {
          return [
            {
              url: "https://example.org/webhook",
              eventTypes: ["text.received"],
              status: "active",
            },
            ...created,
          ];
        },
        async create(rec) {
          created.push({ ...rec, status: "active" });
        },
      },
    },
  };
  await subscribe(client, identity, "https://example.com/webhook");
  const n = created.length;
  assert.ok(n > 0);
  await subscribe(client, identity, "https://example.com/webhook");
  assert.equal(created.length, n);
  assert.ok(
    !created.flatMap((r) => r.eventTypes).some((e) => e.startsWith("call.")),
  );
});

test(
  "only the conversation sender can cancel its active turn, without prompting Pi",
  { timeout: 5000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "inkbox-pi-"));
    const started = Promise.withResolvers();
    const ownerReply = Promise.withResolvers();
    let otherReplies = 0;
    const prompts = [];
    const runtime = createGatewayRuntime(
      { home },
      {
        identity,
        client: {},
        async turn(_, route, _file, signal) {
          prompts.push(route.text);
          started.resolve();
          await new Promise((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            ),
          );
        },
        async reply(route, answer) {
          if (route.message === "other") otherReplies++;
          if (route.message === "owner") ownerReply.resolve(answer);
        },
      },
    );
    try {
      runtime.acceptVerified(sms("first", "Can you help?"));
      await started.promise;
      const other = sms("other", "/stop");
      other.data.text_message.sender_phone_number = "+12025550109";
      runtime.acceptVerified(other);
      while (runtime.eventState("evt-other") === "queued")
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(runtime.eventState("evt-other"), "ignored");
      assert.equal(otherReplies, 0);
      assert.notEqual(runtime.eventState("evt-first"), "canceled");
      runtime.acceptVerified(sms("owner", "/cancel"));
      assert.match(await ownerReply.promise, /Stopped/);
      assert.equal(runtime.eventState("evt-first"), "canceled");
      assert.deepEqual(prompts, ["Can you help?"]);
    } finally {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "/clear removes only this thread's retained Pi session",
  { timeout: 5000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "inkbox-pi-"));
    let sent = Promise.withResolvers();
    const calls = [];
    const runtime = createGatewayRuntime(
      { home },
      {
        identity,
        client: {},
        async turn(_, route, file) {
          let history = "";
          try {
            history = await readFile(file, "utf8");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          calls.push([route.text, history]);
          await writeFile(file, route.text);
          return "OK";
        },
        async reply(_, answer) {
          sent.resolve(answer);
        },
      },
    );
    try {
      for (const [id, text] of [
        ["1", "secret"],
        ["2", "/status"],
        ["3", "/clear"],
        ["4", "hello"],
      ]) {
        sent = Promise.withResolvers();
        runtime.acceptVerified(sms(id, text));
        const answer = await sent.promise;
        if (text === "/status") assert.match(answer, /idle/);
        if (text === "/clear") assert.match(answer, /cleared/);
      }
      assert.deepEqual(calls, [
        ["secret", ""],
        ["hello", ""],
      ]);
    } finally {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "delivery callbacks racing the send response update the receipt, never send a second reply",
  { timeout: 5000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "inkbox-pi-"));
    let sends = 0;
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const runtime = createGatewayRuntime(
      { home },
      {
        identity,
        client: {},
        async turn(_, route, file) {
          await writeFile(file, route.text);
          return "Reply.";
        },
        async reply() {
          sends++;
          entered.resolve();
          await resume.promise;
          return { id: "sent-1" };
        },
      },
    );
    try {
      runtime.acceptVerified(sms("trigger"));
      await entered.promise;
      const receipt = {
        id: "receipt-1",
        event_type: "text.delivery_unconfirmed",
        data: {
          text_message: {
            id: "sent-1",
            direction: "outbound",
            local_phone_number: identity.phoneNumber.number,
          },
        },
      };
      assert.equal(runtime.acceptVerified(receipt), "accepted");
      assert.equal(runtime.acceptVerified(receipt), "duplicate");
      resume.resolve();
      while (runtime.eventState("evt-trigger") === "reply")
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(runtime.eventState("evt-trigger"), "uncertain");
      assert.equal(runtime.eventState(receipt.id), "uncertain");
      runtime.acceptVerified({
        ...receipt,
        id: "receipt-2",
        event_type: "text.delivery_failed",
      });
      assert.equal(runtime.eventState("evt-trigger"), "failed");
      assert.equal(runtime.eventState(receipt.id), "failed");
      assert.equal(sends, 1);
    } finally {
      resume.resolve();
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "external agent events capture results without outgoing replies; scripts are reported, not run",
  { timeout: 5000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "inkbox-pi-"));
    const reports = [],
      turns = [];
    const client = {
      inbound: {
        async reportInboundEventResult(...args) {
          reports.push(args);
        },
      },
    };
    const runtime = createGatewayRuntime(
      { home, allowedSenders: ["src-test"] },
      {
        identity,
        client,
        async turn(_, route, file) {
          turns.push(route.text);
          await writeFile(file, "conversation");
          return "Captured.";
        },
        async reply() {
          assert.fail("No reply destination exists for an external request.");
        },
      },
    );
    const event = (id, handler) => ({
      id: "evt-" + id,
      event_type: "inbound.received",
      data: {
        source: {
          id: "src-test",
          name: "sensor",
          instructions: "Summarize this event.",
        },
        handler,
        event_id: "ev-test",
        delivery_id: id,
        signature_verified: false,
        request: {
          method: "POST",
          content_type: "text/plain",
          body_encoding: "utf8",
          body: "data",
        },
      },
    });
    try {
      const first = event("delivery-a", { type: "agent" });
      assert.equal(runtime.acceptVerified(first), "accepted");
      assert.equal(runtime.acceptVerified(first), "duplicate");
      while (
        runtime.eventState(first.id) === "queued" ||
        runtime.eventState(first.id) === "reply"
      )
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(runtime.eventResult(first.id), "Captured.");
      const { inspectJournal } = await import("../gateway/journal.js");
      assert.equal(
        inspectJournal({ home }, identity, first.id).result,
        "Captured.",
      );
      assert.equal(inspectJournal({ home }, identity).counts.done, 1);
      assert.deepEqual(inspectJournal({ home }, { id: "other" }, first.id), {
        state: "unknown",
      });
      assert.equal(turns.length, 1);
      assert.equal(JSON.parse(turns[0]).senderSignatureVerified, false);
      const second = event("delivery-b", {
        type: "script",
        command: "do-not-run",
      });
      runtime.acceptVerified(second);
      while (runtime.eventState(second.id) === "report")
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(runtime.eventState(second.id), "failed");
      assert.equal(turns.length, 1);
      assert.equal(reports.length, 1);
      assert.equal(reports[0][3].deliveryId, "delivery-b");
    } finally {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "SMS controls are ignored after hydration identifies a group MMS",
  { timeout: 5000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "inkbox-pi-"));
    let prompts = 0,
      replies = 0;
    const runtime = createGatewayRuntime(
      { home },
      {
        client: {},
        identity: {
          ...identity,
          async listTextConversations() {
            return [
              {
                id: "thread-a",
                isGroup: true,
                participants: ["+12025550102", "+12025550109"],
              },
            ];
          },
        },
        async turn() {
          prompts++;
          throw new Error("Group control must not wake Pi");
        },
        async reply() {
          replies++;
        },
      },
    );
    try {
      const evt = sms("group-control", "/clear");
      evt.data.text_message.recipients = null;
      assert.equal(runtime.acceptVerified(evt), "accepted");
      while (runtime.eventState(evt.id) === "queued")
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(runtime.eventState(evt.id), "ignored");
      assert.equal(prompts, 0);
      assert.equal(replies, 0);
    } finally {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("narrowing the sender policy stops work that was queued before restart", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-revoke-sender-"));
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await rm(home, { recursive: true, force: true });
  });
  const config = { home, baseUrl: "https://example.com" };
  const deps = {
    identity,
    client: {},
    turn: () => assert.fail("revoked sender ran Pi"),
  };
  runtime = createGatewayRuntime(config, deps);
  assert.equal(runtime.acceptVerified(sms("pending")), "accepted");
  await runtime.close();
  runtime = createGatewayRuntime(
    { ...config, allowedSenders: ["+12025550999"] },
    deps,
  );
  for (
    let i = 0;
    i < 100 && runtime.eventState("evt-pending") !== "ignored";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.eventState("evt-pending"), "ignored");
});

test(
  "delivery updates are quiet, survive restart, and stay in the sender's conversation until consumed or cleared",
  { timeout: 5000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "inkbox-pi-"));
    const notes = [];
    const deps = {
      identity,
      client: {},
      async turn(_, route, file) {
        notes.push(route.deliveryContext);
        await writeFile(file, route.text);
        return "Reply.";
      },
      async reply(route) {
        return { id: "out-" + route.message };
      },
    };
    let runtime = createGatewayRuntime({ home }, deps);
    async function send(id, text, thread) {
      const event = sms(id, text, thread);
      assert.equal(runtime.acceptVerified(event), "accepted");
      while (runtime.eventState(event.id) !== "done")
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    function notice(id, status, message) {
      assert.equal(
        runtime.acceptVerified({
          id,
          event_type: "text.delivery_" + status,
          data: {
            text_message: {
              id: "out-" + message,
              direction: "outbound",
              local_phone_number: identity.phoneNumber.number,
            },
          },
        }),
        "accepted",
      );
    }
    try {
      await send("initial");
      notice("uncertain", "unconfirmed", "initial");
      await runtime.close();
      runtime = createGatewayRuntime({ home }, deps);
      await send("other", "Hi", "thread-b");
      await send("ask");
      await send("again");
      notice("failure", "failed", "initial");
      await send("update");
      notice("earlier", "failed", "ask");
      await send("reset", "/clear");
      notice("late", "failed", "again");
      await send("new");
      assert.equal(notes.length, 6);
      assert.deepEqual(notes.slice(0, 2), [undefined, undefined]);
      assert.match(notes[2], /0 reported failed, 1 unconfirmed/);
      assert.equal(notes[3], undefined);
      assert.match(notes[4], /1 reported failed, 0 unconfirmed/);
      assert.equal(notes[5], undefined);
    } finally {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
