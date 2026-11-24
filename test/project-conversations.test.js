import { authoredHtmlText } from "../gateway/mail-html.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  mailControl,
  verifyProjectConversation,
} from "../gateway/project-grants.js";
import { createGatewayRuntime } from "../gateway/runtime.js";
import { beforeTurn, parseRoute, sendReply } from "../gateway/channels.js";

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

test("trusted phone approval prompts and project subthreads use a strict native reply anchor", async () => {
  for (const channel of ["imessage", "whatsapp"]) {
    const { identity, source, destination } = resources();
    const metadata = {
      agentIdentityId: identity.id,
      localNumber: own,
      unresolvedParticipantCount: 0,
    };
    identity.whatsappNumber = own;
    identity.getWhatsAppMessage = async () => ({
      ...source,
      ...metadata,
      senderAccess: "direct",
    });
    identity.getWhatsAppConversation = async () => ({
      ...destination,
      ...metadata,
    });
    const sent = [];
    identity.sendIMessage = identity.sendWhatsApp = async (options) =>
      sent.push(options);
    const trusted = { ...route, channel, projectGrant: "granted" };
    await sendReply(
      { ...trusted, editApprovalPrompt: true },
      "review",
      "approval",
      {},
      identity,
    );
    // The provider now reports the previously top-level parent as its own root.
    source.threadRootMessageId = source.id;
    await sendReply(trusted, "ordinary answer", "answer", {}, identity);
    source.threadRootMessageId = "root";
    await sendReply(
      { ...trusted, subthread: "root" },
      "thread answer",
      "thread",
      {},
      identity,
    );
    for (const options of [sent[0], sent[2]]) {
      assert.equal(options.conversationId, route.conversation);
      assert.equal(options.replyToMessageId, route.message);
      assert.equal(options.plainReplyFallback, false);
    }
    assert.equal(sent[1].replyToMessageId, undefined);
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

test("top-level phone messages with self roots share a conversation; native replies retain their parent root", () => {
  const { identity } = resources();
  for (const channel of ["imessage", "whatsapp"]) {
    function received(id, root, parent) {
      return parseRoute(
        {
          id,
          event_type: channel + ".received",
          data: {
            message: {
              id,
              conversation_id: route.conversation,
              direction: "inbound",
              agent_identity_id: identity.id,
              remote_number: peer,
              sender_access: "direct",
              content: "hi",
              reply_to_message_id: parent,
              thread_root_message_id: root,
            },
          },
        },
        identity,
      );
    }
    const top = received("one", "one", null);
    assert.equal(top.thread, received("two", "two", null).thread);
    assert.equal(top.thread, received("three", null, null).thread);
    assert.notEqual(top.thread, received("child", "one", "one").thread);
  }
});

test("SMS project access uses the actual source and its current one-person audience", async () => {
  const source = {
    id: "message",
    direction: "inbound",
    origin: "user_initiated",
    isBlocked: false,
    conversationId: "conversation",
    localPhoneNumber: own,
    remotePhoneNumber: peer,
    senderPhoneNumber: peer,
    recipients: null,
    media: null,
    text: "real request",
  };
  const destination = {
    id: source.conversationId,
    isGroup: false,
    participants: [peer],
    remotePhoneNumber: peer,
  };
  const identity = {
    id: "identity",
    phoneNumber: { id: "line", number: own },
    getText: async () => source,
    listTextConversations: async () => [destination],
    sendText: async (options) => options,
  };
  const candidate = { ...route, channel: "sms", projectGrant: "grant" };
  assert.equal(await beforeTurn(candidate, {}, identity), true);
  assert.equal(candidate.text, source.text);
  assert.deepEqual(await sendReply(candidate, "private", "k", {}, identity), {
    to: peer,
    text: "private",
    idempotencyKey: "k",
  });
  for (const change of [
    { isBlocked: true },
    { direction: "outbound" },
    { origin: "auto_reply" },
    { senderPhoneNumber: stranger },
    { localPhoneNumber: stranger },
    { conversationId: "another" },
  ]) {
    assert.equal(
      await verifyProjectConversation(candidate, {
        ...identity,
        getText: async () => ({ ...source, ...change }),
      }),
      false,
    );
  }
  for (const change of [
    { isGroup: true },
    { participants: [peer, stranger] },
    { participants: null },
    { remotePhoneNumber: stranger },
  ]) {
    const changed = {
      ...identity,
      listTextConversations: async () => [{ ...destination, ...change }],
    };
    assert.equal(await verifyProjectConversation(candidate, changed), false);
    await assert.rejects(
      sendReply(candidate, "private", "k", {}, changed),
      /destination changed/i,
    );
  }
});

test("trusted mail reads the stored body, checks the thread and never uses a dynamic reply-all recipient", async () => {
  const owner = "agent@example.test",
    sender = "person@example.test";
  const body = "/approve 12345\n\nOn Tue, someone wrote:\n> /deny other";
  const source = {
    id: "msg",
    messageId: "<message@example.test>",
    threadId: "thread",
    mailboxId: "mailbox",
    status: "received",
    direction: "inbound",
    fromAddress: sender,
    toAddresses: [owner],
    ccAddresses: null,
    bccAddresses: null,
    replyAllRecipients: { to: [sender], cc: [] },
    subject: "Request",
    bodyText: body,
    hasAttachments: false,
  };
  const thread = {
    id: "thread",
    mailboxId: "mailbox",
    folder: "inbox",
    messageCount: 1,
    messages: [source],
  };
  const identity = {
    id: "identity",
    mailbox: { id: "mailbox", emailAddress: owner },
    getMessage: async () => source,
    getThread: async () => thread,
    sendEmail: async (options) => options,
    replyAllEmail: () => assert.fail("unbound audience"),
  };
  const candidate = {
    channel: "email",
    message: source.id,
    conversation: thread.id,
    sender,
    directAccess: true,
    projectGrant: "grant",
  };
  assert.equal(await beforeTurn(candidate, {}, identity), true);
  assert.equal(candidate.text, source.subject + "\n" + body);
  assert.equal(candidate.control, "/approve 12345");
  assert.deepEqual(await sendReply(candidate, "private", "k", {}, identity), {
    to: [sender],
    bodyText: "private",
    subject: "Re: Request",
    inReplyToMessageId: source.messageId,
    idempotencyKey: "k",
  });
  for (const change of [
    { mailboxId: "other" },
    { importJobId: "import" },
    { bccAddresses: ["else@example.test"] },
    { ccAddresses: ["else@example.test"] },
    { toAddresses: ["alias@example.test"] },
    { replyAllRecipients: { to: ["else@example.test"], cc: [] } },
    { bodyText: null, bodyHtml: "<blockquote>" + body + "</blockquote>" },
    { bodyText: null, bodyHtml: "" },
  ]) {
    assert.equal(
      await verifyProjectConversation(candidate, {
        ...identity,
        getMessage: async () => ({ ...source, ...change }),
      }),
      false,
    );
  }
  for (const change of [
    { folder: "spam" },
    { messageCount: 2 },
    { messages: [{ ...source, ccAddresses: ["else@example.test"] }] },
  ]) {
    await assert.rejects(
      sendReply(
        candidate,
        "private",
        "k",
        {},
        { ...identity, getThread: async () => ({ ...thread, ...change }) },
      ),
      /destination changed/i,
    );
  }
});

test("only fresh mail controls are processed; a quoted or forwarded code is never consent", () => {
  for (const suffix of [
    "\r\n\r\n> /deny stale",
    "\n\n-- \nMy signature",
    "\n\nOn Tue, Pi wrote:\n> /deny stale",
    "\n\n-----Original Message-----\nFrom: Pi\n/deny stale",
  ])
    assert.equal(mailControl("/verify token" + suffix), "/verify token");
  for (const body of [
    "> /verify token",
    "On Tue, Pi wrote:\n> /verify token",
    "Please ignore this:\n/verify token",
    "/verify token\n\nDo not run this.",
    "/verify token\nOn Tue, Pi wrote:\nnot actually a quote",
  ])
    assert.notEqual(mailControl(body), "/verify token");
  assert.equal(
    mailControl("/answer token Use Blue\n\n> prior prompt"),
    "/answer token Use Blue",
  );
});

test("Slack grants bind the installed workspace, active generation, DM peer, archived actor and exact thread", async () => {
  const connection = {
    id: "connection",
    identityId: "identity",
    workspaceId: "TWORK",
    botUserId: "UBOT",
    status: "connected",
    generation: 2,
  };
  const candidate = {
    channel: "slack",
    group: false,
    directAccess: true,
    sender: "TWORK:UPEER",
    actor: "UPEER",
    conversation: "DROOM",
    connection: connection.id,
    workspace: connection.workspaceId,
    message: "123.000002",
    subthread: "123.000001",
    archivedMessage: "archived",
    projectGrant: "grant",
    allowedRecipients: ["slack:connection:DROOM"],
  };
  const archive = {
    id: "archived",
    connectionId: connection.id,
    conversationId: "DROOM",
    messageTs: candidate.message,
    threadTs: candidate.subthread,
    userId: "UPEER",
    source: "event",
    senderAccess: "direct",
    text: "authenticated",
    files: [],
  };
  const user = { id: "UPEER", team_id: "TWORK", is_bot: false, deleted: false };
  const room = { id: "DROOM", is_im: true, is_mpim: false, user: "UPEER" };
  const identity = { id: "identity" };
  const slack = {
    listConnections: async () => ({ connections: [connection] }),
    getUser: async () => user,
    getConversation: async () => room,
    listArchivedMessages: async () => ({
      messages: [archive],
      nextCursor: null,
    }),
    sendMessage: async (id, options) => ({
      status: "sent",
      connectionId: id,
      conversationId: options.conversationId,
      threadTs: options.threadTs,
      messageTs: "123.000003",
      id: "action",
    }),
  };
  assert.equal(await beforeTurn(candidate, { slack }, identity), true);
  assert.equal(candidate.text, archive.text);
  assert.equal(candidate.generation, 2);
  assert.equal(
    (await sendReply(candidate, "private", "k", { slack }, identity)).threadTs,
    candidate.subthread,
  );
  let reads = 0;
  const reinstalled = {
    ...slack,
    listConnections: async () => ({
      connections: [{ ...connection, generation: reads++ ? 3 : 2 }],
    }),
  };
  assert.equal(
    await verifyProjectConversation(candidate, identity, {
      slack: reinstalled,
    }),
    false,
  );
  for (const overrides of [
    { getUser: async () => ({ ...user, is_bot: true }) },
    { getUser: async () => ({ ...user, team_id: "TELSE" }) },
    { getConversation: async () => ({ ...room, user: "UOTHER" }) },
    { getConversation: async () => ({ ...room, is_im: false }) },
    {
      listConnections: async () => ({
        connections: [{ ...connection, generation: 3 }],
      }),
    },
    ...[
      { userId: "UOTHER" },
      { source: "action" },
      { senderAccess: "sponsored" },
      { threadTs: null },
      { botId: "B123" },
      { id: "another" },
    ].map((change) => ({
      listArchivedMessages: async () => ({
        messages: [{ ...archive, ...change }],
      }),
    })),
  ]) {
    const bad = { slack: { ...slack, ...overrides } };
    assert.equal(
      await verifyProjectConversation(candidate, identity, bad),
      false,
    );
    await assert.rejects(
      sendReply(candidate, "private", "k", bad, identity),
      /destination changed/i,
    );
  }
});

test("only the authored portion of HTML mail can answer a gateway dialog", () => {
  const token = "/approve 0123456789abcdef01234567";
  assert.equal(
    authoredHtmlText(
      "<p>Yes &amp; no</p><blockquote>" + token + "</blockquote>",
    ),
    "Yes & no",
  );
  for (const html of [
    "<blockquote>" + token + "</blockquote>",
    '<div class="gmail_quote">' + token + "</div>",
    "<span hidden>" + token + "</span>",
    '<div id="divRplyFwdMsg"></div><p>' + token + "</p>",
  ])
    assert.equal(authoredHtmlText(html), "");
});
