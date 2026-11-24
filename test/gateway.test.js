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

const identity = { id: "agent-test", phoneNumber: { number: "+12025550101" }, imessageEnabled: true };
const sms = (id, text = "Hi", conversation = "thread-a") => ({
  id: "evt-" + id, event_type: "text.received", data: { text_message: {
    id, conversation_id: conversation, direction: "inbound", text,
    sender_phone_number: "+12025550102", local_phone_number: identity.phoneNumber.number
  } }
});

test("signed ingress rejects changed bytes before admission", async () => {
  const seen = [];
  const server = createServer(webhookHandler("test-secret", (event) => seen.push(event.id)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port + "/webhook";
  const body = JSON.stringify(sms("1"));
  const signature = createHmac("sha256", "test-secret").update("request.123." + body).digest("hex");
  const headers = { "x-inkbox-signature": "sha256=" + signature, "x-inkbox-timestamp": "123", "x-inkbox-request-id": "request" };
  try {
    assert.equal((await fetch(url, { method: "POST", body, headers })).status, 202);
    assert.equal((await fetch(url, { method: "POST", body: body + " ", headers })).status, 401);
    assert.deepEqual(seen, ["evt-1"]);
  } finally { await new Promise((done) => server.close(done)); }
});

test("outbound, self, disallowed sender, STOP and other identities cannot wake Pi", () => {
  for (const change of [{ direction: "outbound" }, { sender_phone_number: identity.phoneNumber.number },
    { local_phone_number: "+12025550103" }, { text: " STOP " }, { sender_access: "sponsored" }]) {
    const event = sms("1");
    Object.assign(event.data.text_message, change);
    assert.equal(parseRoute(event, identity), null);
  }
  assert.equal(parseRoute(sms("1"), identity, ["another"]), null);
  const event = sms("1"); event.event_type = "call.ended";
  assert.equal(parseRoute(event, identity), null);
});

test("gateway durably resumes only the originating conversation and suppresses replays", async () => {
  const home = await mkdtemp(join(tmpdir(), "inkbox-pi-"));
  const received = [];
  const config = { home, baseUrl: "https://example.com" };
  let sent = Promise.withResolvers();
  const deps = { identity, client: {}, async turn(_, route, file) {
    let lines = "";
    try { lines = await readFile(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const answer = lines + route.text;
    await writeFile(file, answer, { mode: 0o600 });
    return answer;
  }, async reply(route, answer, key) { received.push([route.conversation, answer, key]); sent.resolve(); } };
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
    assert.deepEqual(received.map(([, text]) => text), ["Hi", "Hi!", "other"]);
    assert.notEqual(received[0][2], received[1][2]);
  } finally { await runtime?.close(); await rm(home, { recursive: true, force: true }); }
});

test("reply routing is bound to the inbound group, never model-supplied destinations", async () => {
  const route = parseRoute(sms("1"), identity);
  let sent;
  await sendReply(route, "Reply", "stable", {}, { async sendText(args) { sent = args; } });
  assert.deepEqual(sent, { conversationId: "thread-a", text: "Reply", idempotencyKey: "stable" });
});

test("subscription reconciliation preserves another URL and excludes calling", async () => {
  const created = [];
  const client = { webhooks: { subscriptions: {
    async list() { return [{ url: "https://example.org/webhook", eventTypes: ["text.received"], status: "active" }, ...created]; },
    async create(rec) { created.push({ ...rec, status: "active" }); }
  } } };
  await subscribe(client, identity, "https://example.com/webhook");
  const n = created.length;
  assert.ok(n > 0);
  await subscribe(client, identity, "https://example.com/webhook");
  assert.equal(created.length, n);
  assert.ok(!created.flatMap((r) => r.eventTypes).some((e) => e.startsWith("call.")));
});
