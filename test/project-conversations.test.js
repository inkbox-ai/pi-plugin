import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { verifyProjectConversation } from "../gateway/project-grants.js";
import { createGatewayRuntime } from "../gateway/runtime.js";
import { beforeTurn, sendReply } from "../gateway/channels.js";

const peer = "+12025550123",
  own = "+12025550100",
  stranger = "+12025550124";
const route = {
  channel: "imessage",
  message: "message",
  conversation: "conversation",
  sender: peer,
  assignment: null,
  directAccess: true,
};
function resources() {
  const source = {
    id: route.message,
    conversationId: route.conversation,
    direction: "inbound",
    service: "imessage",
    isGroup: false,
    isBlocked: false,
    remoteNumber: peer,
    participants: [peer],
    content: "authenticated prompt",
    assignmentId: null,
  };
  const destination = {
    id: route.conversation,
    isGroup: false,
    remoteNumber: peer,
    participants: [peer],
    assignmentId: null,
  };
  const identity = {
    id: "identity",
    imessageEnabled: true,
    imessageNumber: { number: own },
    getIMessage: async (id) => ({ ...source, id }),
    getIMessageConversation: async () => destination,
  };
  return { identity, source, destination };
}

test("project prompts require an owned, native one-to-one iMessage; never trust the receipt's body or a different audience", async () => {
  const { identity, source, destination } = resources();
  const candidate = { ...route, text: "webhook body" };
  assert.equal(await verifyProjectConversation(candidate, identity), true);
  assert.equal(candidate.text, source.content);
  for (const change of [
    { channel: "email" },
    { channel: "sms" },
    { allowedRecipients: [stranger] },
    { sender: stranger },
    { group: true },
    { sponsored: true },
    { directAccess: false },
    { companion: {} },
  ])
    assert.equal(
      await verifyProjectConversation({ ...route, ...change }, identity),
      false,
    );
  for (const change of [
    { isGroup: true },
    { service: "sms" },
    { service: "rcs" },
    { wasDowngraded: true },
    { direction: "outbound" },
    { isBlocked: true },
    { senderNumber: stranger },
    { assignmentId: "other" },
  ]) {
    const scoped = {
      ...identity,
      getIMessage: async () => ({ ...source, ...change }),
    };
    assert.equal(await verifyProjectConversation(route, scoped), false);
  }
  for (const change of [
    { remoteNumber: stranger },
    { participants: [stranger] },
    { id: "other" },
    { isGroup: true },
  ]) {
    const scoped = {
      ...identity,
      getIMessageConversation: async () => ({ ...destination, ...change }),
    };
    assert.equal(await verifyProjectConversation(route, scoped), false);
  }
});

test("changing a project's recipient after Pi started blocks delivery of the answer", async () => {
  const { identity, destination } = resources();
  let sent = false;
  identity.sendIMessage = async () => {
    sent = true;
  };
  const candidate = { ...route, projectGrant: "owner-granted" };
  assert.equal(await beforeTurn(candidate, {}, identity), true);
  destination.isGroup = true;
  destination.participants = [peer, stranger];
  await assert.rejects(
    sendReply(candidate, "private answer", "key", {}, identity),
    /destination changed/i,
  );
  assert.equal(sent, false);
});

test("WhatsApp also verifies the actual identity, currently assigned line and direct participant", async () => {
  const { source, destination } = resources();
  const metadata = {
    agentIdentityId: "identity",
    localNumber: own,
    unresolvedParticipantCount: 0,
  };
  const identity = {
    id: "identity",
    whatsappNumber: own,
    getWhatsAppMessage: async () => ({
      ...source,
      ...metadata,
      senderAccess: "direct",
    }),
    getWhatsAppConversation: async () => ({ ...destination, ...metadata }),
  };
  const candidate = { ...route, channel: "whatsapp" };
  assert.equal(await verifyProjectConversation(candidate, identity), true);
  for (const change of [
    { agentIdentityId: "other" },
    { localNumber: stranger },
    { unresolvedParticipantCount: 1 },
    { activeConversationId: "different" },
    { isGroup: true },
  ]) {
    const scoped = {
      ...identity,
      getWhatsAppConversation: async () => ({
        ...destination,
        ...metadata,
        ...change,
      }),
    };
    assert.equal(await verifyProjectConversation(candidate, scoped), false);
  }
});

test("trusted sessions survive restart but revocation suppresses saved replies and re-grant starts clean", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "inkbox-pi-project-"));
  const { identity, source } = resources();
  const config = {
    home,
    baseUrl: "https://example.com",
    projectDirectory: home,
    projectFiles: ["project.txt"],
  };
  const grants = ["imessage:conversation:" + peer];
  const turns = [],
    sent = [];
  let runtime,
    failSend = false;
  t.after(async () => {
    await runtime?.close();
    await rm(home, { recursive: true, force: true });
  });
  identity.sendIMessage = async ({
    conversationId,
    text,
    replyToMessageId,
  }) => {
    assert.equal(conversationId, "conversation");
    assert.equal(replyToMessageId, undefined);
    if (failSend) throw new Error("offline");
    sent.push(text);
  };
  function open(trustedConversations) {
    runtime = createGatewayRuntime(
      { ...config, trustedConversations },
      {
        identity,
        client: {},
        async turn(_, route, file) {
          let old = "";
          try {
            old = await readFile(file, "utf8");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          turns.push([
            route.message,
            Boolean(route.projectGrant),
            old,
            route.text,
          ]);
          await writeFile(file, route.message);
          return route.message;
        },
      },
    );
  }
  function submit(id) {
    return runtime.acceptVerified({
      id,
      event_type: "imessage.received",
      data: {
        message: {
          id,
          conversation_id: "conversation",
          direction: "inbound",
          remote_number: peer,
          sender_access: "direct",
          content: "unverified copy",
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
      "Expected " + id + " to be " + state + "; saw " + runtime.eventState(id),
    );
  }
  open(grants);
  submit("first");
  await until("first", "done");
  await runtime.close();
  open(grants);
  failSend = true;
  submit("second");
  await until("second", "reply");
  await runtime.close();
  open([]);
  failSend = false;
  await until("second", "ignored");
  submit("third");
  await until("third", "done");
  await runtime.close();
  open(grants);
  submit("fourth");
  await until("fourth", "done");
  assert.deepEqual(turns.slice(0, 2), [
    ["first", true, "", source.content],
    ["second", true, "first", source.content],
  ]);
  assert.equal(turns[2][1], false);
  assert.equal(turns[2][2], "");
  assert.deepEqual(turns[3], ["fourth", true, "", source.content]);
  assert.deepEqual(sent, ["first", "third", "fourth"]);
});

test(
  "project model turns cannot race each other's file edits; unrelated tool-free turns still run",
  { timeout: 10000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "inkbox-pi-project-lane-"));
    const { identity, source, destination } = resources();
    identity.getIMessage = async (id) => ({
      ...source,
      id,
      conversationId: id,
    });
    identity.getIMessageConversation = async (id) => ({ ...destination, id });
    const release = Promise.withResolvers(),
      first = Promise.withResolvers(),
      ordinary = Promise.withResolvers(),
      second = Promise.withResolvers();
    const entries = [];
    const runtime = createGatewayRuntime(
      {
        home,
        baseUrl: "https://example.com",
        projectDirectory: home,
        projectFiles: ["project.txt"],
        trustedConversations: ["first", "second"].map(
          (id) => "imessage:" + id + ":" + peer,
        ),
      },
      {
        identity,
        client: {},
        async turn(_, candidate, file) {
          entries.push("start " + candidate.message);
          if (candidate.message === "first") {
            first.resolve();
            await release.promise;
          }
          if (candidate.message === "ordinary") ordinary.resolve();
          await writeFile(file, candidate.message);
          entries.push("end " + candidate.message);
          if (candidate.message === "second") second.resolve();
          return "ok";
        },
        async reply() {},
      },
    );
    t.after(async () => {
      release.resolve();
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    });
    for (const id of ["first", "second", "ordinary"]) {
      runtime.acceptVerified({
        id,
        event_type: "imessage.received",
        data: {
          message: {
            id,
            conversation_id: id,
            direction: "inbound",
            remote_number: peer,
            sender_access: "direct",
            content: "hello",
          },
        },
      });
    }
    await Promise.all([first.promise, ordinary.promise]);
    assert.ok(entries.includes("start first"));
    assert.equal(entries.includes("start second"), false);
    release.resolve();
    await second.promise;
    assert.ok(entries.indexOf("end first") < entries.indexOf("start second"));
  },
);

test(
  "a verified stop interrupts the owner's project turn without replaying possible edits",
  { timeout: 5000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "pi-stop-project-"));
    const { identity, source } = resources();
    identity.getIMessage = async (id) => ({
      ...source,
      id,
      content: id === "stop" ? "/stop" : "change the file",
    });
    const started = Promise.withResolvers(),
      stopped = Promise.withResolvers();
    const runtime = createGatewayRuntime(
      {
        home,
        projectDirectory: home,
        projectFiles: ["example.txt"],
        trustedConversations: ["imessage:conversation:" + peer],
      },
      {
        identity,
        client: {},
        async turn(_config, _route, _file, signal) {
          started.resolve();
          await new Promise((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            ),
          );
        },
        async reply(route, text) {
          if (route.message === "stop") stopped.resolve(text);
        },
      },
    );
    t.after(async () => {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    });
    function submit(id, content) {
      runtime.acceptVerified({
        id,
        event_type: "imessage.received",
        data: {
          message: {
            id,
            content,
            conversation_id: "conversation",
            direction: "inbound",
            remote_number: peer,
            sender_access: "direct",
          },
        },
      });
    }
    submit("work", "change the file");
    await started.promise;
    submit("stop", "/stop");
    assert.match(await stopped.promise, /Earlier file edits may remain/);
    assert.equal(runtime.eventState("work"), "uncertain");
  },
);
