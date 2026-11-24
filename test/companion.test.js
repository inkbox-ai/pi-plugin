import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRoute,
  beforeTurn,
  sendReply,
  subscribe,
} from "../gateway/channels.js";

const id = {
  id: "identity",
  agentHandle: "tester",
  phoneNumber: { number: "+12025550111" },
  async listTextConversations() {
    return [
      {
        id: "conversation",
        isGroup: true,
        participants: ["+12025550122", "+12025550133"],
      },
    ];
  },
};
function sms(text, phase = "initialization", activation = "group-A") {
  return {
    id: "event",
    event_type: "text.received",
    companion: {
      phase,
      channel: "phone",
      sequence: 1,
      scope_id: "scope",
      conversation_id: "conversation",
      activation_id: activation,
    },
    data: {
      text_message: {
        id: "source",
        direction: "inbound",
        sender_access: "direct",
        sender_phone_number: "+12025550122",
        local_phone_number: id.phoneNumber.number,
        text,
        conversation_id: "conversation",
      },
    },
  };
}
function snapshot(route) {
  return {
    scopeId: "scope",
    activationId: "group-A",
    conversationId: "conversation",
    channel: "phone",
    replyContext: { channel: "phone", conversationId: "conversation" },
    entries: [
      {
        id: "source",
        author: route.sender,
        isTrigger: true,
        historical: false,
      },
    ],
    text: "Verified earlier conversation.",
  };
}
test("Companion snapshots, sponsorship, session isolation and send-time revocation", async () => {
  const event = sms("hello");
  const route = parseRoute(event, id, ["+12025550122"]);
  assert(route.noControls);
  assert.notEqual(
    route.thread,
    parseRoute(sms("hello", "initialization", "group-B"), id).thread,
  );
  const page = snapshot(route);
  const client = {
    companion: {
      loadInitialization: async () => page,
      activationMessages: async () => ({ ...page, activationId: "other" }),
    },
  };
  assert(await beforeTurn(route, client, id));
  assert.match(route.text, /Verified earlier conversation/);
  await assert.rejects(
    sendReply(route, "hello", "key", client, id),
    /scope has changed/,
  );
  page.entries[0].author = "+12025550133";
  assert.equal(
    await beforeTurn(parseRoute(event, id, ["+12025550122"]), client, id),
    false,
  );
});
test("mention mode ignores historical text, URLs and lookalikes", async () => {
  for (const text of [
    "email@example.com",
    "hey @tester-long",
    "https://example.com/@tester",
  ]) {
    const event = sms(text);
    event.companion.history = [{ text: "@tester" }];
    const route = parseRoute(event, id, [], { groupReplyMode: "mention" });
    assert.equal(await beforeTurn(route, {}, id), false);
  }
  const addressed = parseRoute(sms("Hey @tester!"), id, [], {
    groupReplyMode: "mention",
  });
  assert(
    await beforeTurn(
      addressed,
      { companion: { loadInitialization: async () => snapshot(addressed) } },
      id,
    ),
  );
  const event = sms("@tester");
  event.companion.conversation_id = "another";
  assert.equal(parseRoute(event, id), null);
  delete event.companion;
  event.data.text_message.sender_access = "sponsored";
  assert.equal(
    parseRoute(event, id, [], { companionResponseMode: "relaxed" }),
    null,
  );
});
test("only the latest owned A2A caller message can run or receive a reply", async () => {
  const event = {
    id: "evt",
    event_type: "a2a.task.message",
    data: {
      task_id: "task",
      context_id: "context",
      message_id: "source",
      caller: { identity_id: "peer", handle: "peer" },
      parts: [{ text: "stale envelope" }],
    },
  };
  const route = parseRoute(event, id);
  const task = {
    id: "task",
    contextId: "context",
    state: "working",
    caller: { identityId: "peer", handle: "peer" },
    target: { identityId: id.id },
    messages: [
      { messageId: "source", role: "caller", parts: [{ text: "current" }] },
    ],
  };
  let replies = 0;
  const agent = {
    ...id,
    a2aTask: async () => task,
    a2aReply: async () => ++replies,
  };
  assert(await beforeTurn(route, {}, agent));
  assert.equal(route.text, "current");
  task.messages.push({
    messageId: "newer",
    role: "caller",
    parts: [{ text: "follow-up" }],
  });
  assert.equal(await beforeTurn(route, {}, agent), false);
  await sendReply(route, "late answer", "key", {}, agent);
  assert.equal(replies, 0);
});
test("Slack reconnect cannot send an answer generated for the old connection", async () => {
  const route = parseRoute(
    {
      id: "evt",
      event_type: "slack.mention_received",
      data: {
        identity_id: id.id,
        connection_id: "conn",
        workspace_id: "team",
        actor_id: "person",
        message_ts: "10.000001",
        conversation_id: "channel",
        event: { text: "hi" },
      },
    },
    id,
    [],
    { slackEnabled: true },
  );
  const conn = {
    id: "conn",
    identityId: id.id,
    workspaceId: "team",
    status: "connected",
    generation: 2,
  };
  const client = {
    slack: { listConnections: async () => ({ connections: [conn] }) },
  };
  assert(await beforeTurn(route, client, id));
  conn.generation++;
  await assert.rejects(sendReply(route, "late", "key", client, id), /changed/);
});
test("email uses the full verified body; iMessage cannot reply across threads", async () => {
  const event = {
    id: "evt",
    event_type: "message.received",
    data: {
      message: {
        id: "mail",
        direction: "inbound",
        mailbox_id: "box",
        thread_id: "thread",
        from_address: "sender@example.com",
        snippet: "teaser",
      },
    },
  };
  const agent = {
    ...id,
    mailbox: { id: "box", emailAddress: "agent@example.com" },
    getMessage: async () => ({
      id: "mail",
      threadId: "thread",
      direction: "inbound",
      mailboxId: "box",
      fromAddress: "sender@example.com",
      bodyText: "complete message",
      replyAllRecipients: { to: ["sender@example.com"], cc: [] },
    }),
  };
  const route = parseRoute(event, agent);
  assert(await beforeTurn(route, {}, agent));
  assert.equal(route.text, "complete message");
  const im = {
    ...id,
    imessageEnabled: true,
    getIMessage: async () => ({
      id: "msg",
      conversationId: "elsewhere",
      direction: "inbound",
      remoteNumber: "+12025550122",
    }),
  };
  const inbound = parseRoute(
    {
      id: "evt",
      event_type: "imessage.received",
      data: {
        message: {
          direction: "inbound",
          id: "msg",
          conversation_id: "conversation",
          sender_number: "+12025550122",
          content: "hello",
        },
      },
    },
    im,
  );
  assert.equal(await beforeTurn(inbound, {}, im), false);
  await assert.rejects(
    sendReply(inbound, "answer", "key", {}, im),
    /destination changed/,
  );
});

test("subscriptions request receipts for every configured messaging channel", async () => {
  const rows = [];
  const subscriptions = {
    list: async () => [],
    create: async (row) => rows.push(row),
  };
  await subscribe(
    { webhooks: { subscriptions } },
    {
      ...id,
      mailbox: { id: "box" },
      imessageEnabled: true,
      whatsappEnabled: true,
    },
    "https://example.com/events",
  );
  const wanted = rows.flatMap((row) => row.eventTypes);
  for (const type of [
    "message.transcription_finished",
    "message.failed",
    "message.bounced",
    "text.delivery_failed",
    "text.delivery_unconfirmed",
    "imessage.delivery_failed",
    "whatsapp.delivery_failed",
    "whatsapp.delivery_unconfirmed",
  ])
    assert(wanted.includes(type), type);
});

test("a sender grant does not authorize every destination in an ordinary group", async () => {
  const evt = sms("hello");
  delete evt.companion;
  evt.data.text_message.recipients = null;
  evt.data.text_message.remote_phone_number = "+12025550122";
  const route = parseRoute(evt, id, ["+12025550122"]);
  const current = {
    id: "conversation",
    isGroup: true,
    participants: ["+12025550122", "+12025550133"],
  };
  const agent = {
    ...id,
    getText: async () => ({
      id: "source",
      conversationId: "conversation",
      direction: "inbound",
      localPhoneNumber: id.phoneNumber.number,
      senderPhoneNumber: "+12025550122",
    }),
    listTextConversations: async () => [current],
  };
  assert.equal(await beforeTurn(route, {}, agent), false);
  const permitted = parseRoute(evt, id, current.participants);
  assert(await beforeTurn(permitted, {}, agent));
  current.participants = [...current.participants, "+12025550144"];
  await assert.rejects(
    sendReply(permitted, "late answer", "key", {}, agent),
    /destination changed/,
  );
});

test("unclassified Companion messages do not inherit direct access", () => {
  const evt = sms("Hello");
  delete evt.data.text_message.sender_access;
  assert.equal(parseRoute(evt, id), null);
});

test("SMS group membership is authoritative even without group fields in the webhook", async () => {
  const event = sms("/clear");
  delete event.companion;
  event.data.text_message.recipients = null;
  const route = parseRoute(event, id);
  const members = ["+12025550122", "+12025550133"];
  const calls = [];
  const agent = {
    ...id,
    listTextConversations: async (options) => {
      calls.push(options);
      if (!options.offset)
        return Array.from({ length: 200 }, (_, i) => ({
          id: "unrelated-" + i,
        }));
      return [{ id: "conversation", isGroup: true, participants: members }];
    },
  };
  assert(await beforeTurn(route, {}, agent));
  assert.equal(route.group, true);
  assert.equal(route.noControls, true);
  assert.deepEqual(
    calls.map((c) => c.offset),
    [0, 200],
  );
  assert(
    calls.every((c) => c.includeGroups && c.participants[0] === "+12025550122"),
  );
  const mentionOnly = parseRoute(event, id, [], { groupReplyMode: "mention" });
  assert.equal(await beforeTurn(mentionOnly, {}, agent), false);
  members.push("+12025550144");
  await assert.rejects(
    sendReply(route, "old cohort answer", "key", {}, agent),
    /destination changed/,
  );
});

test("Slack wakes and subscriptions require an explicit opt-in", async () => {
  const event = {
    id: "evt",
    event_type: "slack.dm_received",
    data: {
      identity_id: id.id,
      connection_id: "conn",
      workspace_id: "team",
      actor_id: "peer",
      message_ts: "900.01",
      conversation_id: "dm",
      event: { text: "hello" },
    },
  };
  assert.equal(parseRoute(event, id), null);
  assert.ok(parseRoute(event, id, [], { slackEnabled: true }));
  for (const slackEnabled of [false, true]) {
    const rows = [];
    const subscriptions = {
      list: async () => [],
      create: async (row) => rows.push(row),
    };
    await subscribe(
      { webhooks: { subscriptions } },
      id,
      "https://example.com/events",
      { slackEnabled },
    );
    assert.equal(
      rows.some((row) => row.eventTypes.includes("slack.dm_received")),
      slackEnabled,
    );
  }
});

test("a changed reply-all audience is not sent a previously generated reply", async () => {
  const event = {
    id: "evt",
    event_type: "message.received",
    data: {
      message: {
        direction: "inbound",
        id: "source",
        mailbox_id: "box",
        thread_id: "thread",
        from_address: "sender@example.com",
        body: "hello",
      },
    },
  };
  const source = {
    id: "source",
    direction: "inbound",
    mailboxId: "box",
    threadId: "thread",
    fromAddress: "sender@example.com",
    bodyText: "hello",
    replyAllRecipients: { to: ["sender@example.com"], cc: [] },
  };
  const owner = {
    ...id,
    mailbox: { id: "box", emailAddress: "agent@example.com" },
    getMessage: async () => source,
    replyAllEmail: async () => assert.fail("must not send"),
  };
  const route = parseRoute(event, owner);
  assert.ok(await beforeTurn(route, {}, owner));
  source.replyAllRecipients.cc.push("new@example.com");
  await assert.rejects(
    sendReply(route, "answer", "key", {}, owner),
    /destination changed/,
  );
});

test("Slack group mention mode requires a native mention, not quoted plain text", () => {
  const event = {
    id: "evt",
    event_type: "slack.group_dm_received",
    data: {
      identity_id: id.id,
      connection_id: "conn",
      workspace_id: "team",
      actor_id: "person",
      conversation_id: "channel",
      message_ts: "10.000001",
      event: { text: "Literal @agent" },
    },
  };
  const options = { slackEnabled: true, groupReplyMode: "mention" };
  assert.equal(parseRoute(event, id, [], options), null);
  assert.ok(
    parseRoute(
      { ...event, event_type: "slack.mention_received" },
      id,
      [],
      options,
    ),
  );
});

test("blocked messages and changes to a group audience prevent WhatsApp replies", async () => {
  const sender = "+12025550101";
  const peer = "+12025550102";
  const source = {
    id: "msg",
    direction: "inbound",
    agentIdentityId: id.id,
    conversationId: "group",
    isGroup: true,
    senderNumber: sender,
    isBlocked: false,
  };
  const dest = {
    id: "group",
    agentIdentityId: id.id,
    isGroup: true,
    participants: [sender, peer],
    unresolvedParticipantCount: 0,
  };
  const owner = {
    ...id,
    whatsappEnabled: true,
    getWhatsAppMessage: async () => source,
    getWhatsAppConversation: async () => dest,
    sendWhatsApp: async () => assert.fail("should not send"),
  };
  const message = {
    id: "msg",
    direction: "inbound",
    agent_identity_id: id.id,
    conversation_id: "group",
    is_group: true,
    sender_number: sender,
    content: "Hi",
  };
  const incoming = (data) => ({
    id: "event",
    event_type: "whatsapp.received",
    data: { message: data },
  });
  assert.equal(
    parseRoute(incoming({ ...message, is_blocked: true }), owner),
    null,
  );
  const route = parseRoute(incoming(message), owner);
  assert.ok(await beforeTurn(route, {}, owner));
  dest.participants.push("+12025550103");
  await assert.rejects(
    sendReply(route, "answer", "key", {}, owner),
    /destination changed/,
  );
  dest.participants.pop();
  source.isBlocked = true;
  assert.equal(await beforeTurn(route, {}, owner), false);
});
