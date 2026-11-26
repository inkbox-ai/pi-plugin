// Network peers for gateway tests. Source reads are kept separate from the
// verified event envelopes: the gateway must resolve the actual SDK message,
// participants and destination itself.
//
// Every factory returns { channel, client, identity, replies, lookups, peers,
// event }. `event(id, chat, text, threadRoot, extra)` stores the source and
// returns its signed-event payload; `extra` is merged into `data`, which is how
// an event names the sender (`contacts`, `agent_identities`, `contact_id`).
// The phone fixtures also have one group, `group`, whose members are both
// peers; `groupEvent(id, sender, text, extra)` is a member's message in it.

const AGENT = "agent";
const HANDLE = "fixture";

// An address book over SDK-shaped contacts, matched by exact email or phone.
function addressBook(directory = []) {
  const lookups = [];
  return {
    lookups,
    contacts: {
      async lookup(query) {
        lookups.push(query);
        const address = query.email ?? query.phone;
        return directory.filter((contact) =>
          [...(contact.emails ?? []), ...(contact.phones ?? [])].some(
            (entry) => entry.value.toLowerCase() === address,
          ),
        );
      },
    },
  };
}

// `replies` and `book` can be shared so one identity answers on several channels.
function shared(options = {}) {
  return {
    replies: options.replies ?? [],
    book: options.book ?? addressBook(options.directory),
  };
}

export function nativePhoneFixture(channel, options) {
  const { replies, book } = shared(options);
  const peers = { "owners-chat": "+12025550102", "other-chat": "+12025550103" };
  const sources = new Map();
  const line = "+12025550101";
  const metadata = {
    agentIdentityId: AGENT,
    localNumber: line,
    unresolvedParticipantCount: 0,
  };
  const topRoot = (id) => (channel === "imessage" ? id : null);
  const group = { id: "team-chat", members: Object.values(peers) };
  const identity = {
    id: AGENT,
    agentHandle: HANDLE,
    imessageEnabled: true,
    imessageNumber: { number: line },
    whatsappNumber: line,
    async [channel === "imessage" ? "getIMessage" : "getWhatsAppMessage"](id) {
      return sources.get(id);
    },
    async [channel === "imessage"
      ? "getIMessageConversation"
      : "getWhatsAppConversation"](id) {
      const peer = peers[id];
      return {
        id,
        ...metadata,
        isGroup: id === group.id,
        remoteNumber: peer ?? null,
        participants: id === group.id ? group.members : [peer],
        assignmentId: null,
      };
    },
    async [channel === "imessage" ? "sendIMessage" : "sendWhatsApp"](message) {
      if (message.replyToMessageId) {
        const parent = sources.get(message.replyToMessageId);
        parent.threadRootMessageId ??= parent.id;
      }
      replies.push({ channel, ...message });
      return { id: channel + "-" + replies.length };
    },
  };
  function event(id, chat, text, threadRoot, extra = {}) {
    const peer = peers[chat];
    sources.set(id, {
      id,
      conversationId: chat,
      threadRootMessageId: threadRoot ?? topRoot(id),
      ...metadata,
      senderAccess: "direct",
      direction: "inbound",
      service: "imessage",
      isGroup: false,
      isBlocked: false,
      remoteNumber: peer,
      participants: [peer],
      assignmentId: null,
      content: text,
    });
    return {
      id,
      event_type: channel + ".received",
      data: {
        message: {
          id,
          conversation_id: chat,
          thread_root_message_id: threadRoot ?? topRoot(id),
          agent_identity_id: identity.id,
          remote_number: peer,
          direction: "inbound",
          sender_access: "direct",
          content: text,
        },
        ...extra,
      },
    };
  }
  function groupEvent(id, sender, text, extra = {}) {
    sources.set(id, {
      id,
      conversationId: group.id,
      threadRootMessageId: topRoot(id),
      ...metadata,
      senderAccess: "direct",
      direction: "inbound",
      service: "imessage",
      isGroup: true,
      isBlocked: false,
      senderNumber: sender,
      remoteNumber: null,
      participants: group.members,
      assignmentId: null,
      content: text,
    });
    return {
      id,
      event_type: channel + ".received",
      data: {
        message: {
          id,
          conversation_id: group.id,
          thread_root_message_id: topRoot(id),
          agent_identity_id: identity.id,
          sender_number: sender,
          is_group: true,
          participants: group.members,
          direction: "inbound",
          sender_access: "direct",
          content: text,
        },
        ...extra,
      },
    };
  }
  return {
    channel,
    client: { contacts: book.contacts },
    identity,
    replies,
    lookups: book.lookups,
    peers,
    group,
    event,
    groupEvent,
  };
}

export function smsFixture(options) {
  const { replies, book } = shared(options);
  const line = "+12025550101";
  const peers = { "owners-chat": "+12025550102", "other-chat": "+12025550103" };
  const sources = new Map();
  const identity = {
    id: AGENT,
    agentHandle: HANDLE,
    phoneNumber: { id: "phone", number: line, smsStatus: "ready" },
    async getText(id) {
      return sources.get(id);
    },
    async listTextConversations({ participants }) {
      return Object.entries(peers)
        .filter(([, peer]) => participants.includes(peer))
        .map(([id, peer]) => ({
          id,
          isGroup: false,
          participants: [peer],
          remotePhoneNumber: peer,
        }));
    },
    async sendText(message) {
      replies.push({ channel: "sms", ...message });
      return {
        id: "sms-" + replies.length,
        direction: "outbound",
        remotePhoneNumber: peers[message.conversationId],
        ...message,
      };
    },
  };
  function event(id, chat, text, _threadRoot, extra = {}) {
    const peer = peers[chat];
    sources.set(id, {
      id,
      direction: "inbound",
      origin: "user_initiated",
      isBlocked: false,
      conversationId: chat,
      localPhoneNumber: line,
      remotePhoneNumber: peer,
      senderPhoneNumber: peer,
      text,
      media: null,
      recipients: null,
    });
    return {
      id,
      event_type: "text.received",
      data: {
        text_message: {
          id,
          direction: "inbound",
          sender_access: "direct",
          origin: "user_initiated",
          local_phone_number: line,
          remote_phone_number: peer,
          sender_phone_number: peer,
          conversation_id: chat,
          text,
        },
        ...extra,
      },
    };
  }
  return {
    channel: "sms",
    client: { contacts: book.contacts },
    identity,
    replies,
    lookups: book.lookups,
    peers,
    event,
  };
}

export function emailFixture(options) {
  const { replies, book } = shared(options);
  const own = "agent@example.test";
  const peers = {
    "owners-chat": "owner@example.test",
    "other-chat": "other@example.test",
  };
  const sources = new Map();
  const identity = {
    id: AGENT,
    agentHandle: HANDLE,
    emailAddress: own,
    mailbox: { id: "mailbox", emailAddress: own, agentIdentityId: AGENT },
    async getMessage(id) {
      return sources.get(id);
    },
    async replyAllEmail(messageId, message) {
      const source = sources.get(messageId);
      replies.push({
        channel: "email",
        conversationId: source.threadId,
        replyToMessageId: messageId,
        text: message.bodyText,
        idempotencyKey: message.idempotencyKey,
      });
      return {
        id: "email-" + replies.length,
        mailboxId: "mailbox",
        threadId: source.threadId,
        direction: "outbound",
        status: "sent",
      };
    },
  };
  function event(id, chat, text, _threadRoot, extra = {}) {
    const peer = peers[chat];
    sources.set(id, {
      id,
      mailboxId: "mailbox",
      threadId: chat,
      messageId: "<" + id + "@example.test>",
      direction: "inbound",
      status: "received",
      fromAddress: peer,
      toAddresses: [own],
      ccAddresses: null,
      bccAddresses: null,
      subject: "Project work",
      bodyText: text,
      bodyHtml: null,
      attachmentMetadata: null,
      hasAttachments: false,
      replyAllRecipients: { to: [peer], cc: [] },
    });
    return {
      id,
      event_type: "message.received",
      data: {
        message: {
          id,
          direction: "inbound",
          mailbox_id: "mailbox",
          thread_id: chat,
          sender_access: "direct",
          from_address: peer,
          to_addresses: [own],
          cc_addresses: [],
          subject: "Project work",
          body: text,
        },
        ...extra,
      },
    };
  }
  return {
    channel: "email",
    client: { contacts: book.contacts },
    identity,
    replies,
    lookups: book.lookups,
    peers,
    event,
  };
}

export function slackFixture(options) {
  const { replies, book } = shared(options);
  const connection = {
    id: "conn",
    identityId: AGENT,
    workspaceId: "TTEAM",
    generation: 1,
    status: "connected",
    botUserId: "UBOT",
  };
  const chats = {
    "owners-chat": ["DOWNER", "UOWNER"],
    "other-chat": ["DOTHER", "UOTHER"],
  };
  const sources = new Map();
  const slack = {
    async listConnections() {
      return { connections: [connection] };
    },
    async getUser(_, id) {
      return { id, team_id: "TTEAM", is_bot: false };
    },
    async listArchivedMessages(_, { conversationId, afterTs, beforeTs }) {
      return {
        messages: [...sources.values()].filter(
          (m) =>
            m.conversationId === conversationId &&
            m.messageTs > afterTs &&
            m.messageTs < beforeTs,
        ),
        nextCursor: null,
      };
    },
    async sendMessage(connectionId, message) {
      const [chat] = Object.entries(chats).find(
        ([, [id]]) => id === message.conversationId,
      );
      replies.push({
        channel: "slack",
        connectionId,
        ...message,
        conversationId: chat,
      });
      return {
        id: "slack-" + replies.length,
        connectionId,
        conversationId: message.conversationId,
        threadTs: message.threadTs,
        messageTs: "1800000000." + String(replies.length).padStart(6, "0"),
        status: "sent",
      };
    },
  };
  function event(id, chat, text, threadRoot, extra = {}) {
    const [conversation, user] = chats[chat];
    const ts = "1700000000." + String(sources.size + 1).padStart(6, "0");
    const archived = "archived-" + id;
    const threadTs = threadRoot ? sources.get(threadRoot).messageTs : null;
    sources.set(id, {
      id: archived,
      messageTs: ts,
      connectionId: connection.id,
      conversationId: conversation,
      userId: user,
      threadTs,
      source: "event",
      senderAccess: "direct",
      text,
      files: [],
      botId: null,
      subtype: null,
    });
    return {
      id,
      event_type: threadTs
        ? "slack.thread_reply_received"
        : "slack.dm_received",
      data: {
        identity_id: AGENT,
        connection_id: connection.id,
        workspace_id: connection.workspaceId,
        conversation_id: conversation,
        actor_id: user,
        actor_profile: { id: user, team_id: "TTEAM", is_bot: false },
        message_id: archived,
        message_ts: ts,
        thread_ts: threadTs,
        sender_access: "direct",
        message_kinds: threadTs ? ["dm", "thread_reply"] : ["dm"],
        event: {
          type: "message",
          channel: conversation,
          channel_type: "im",
          ...(threadTs ? { thread_ts: threadTs } : {}),
          user,
          ts,
          text,
        },
        ...extra,
      },
    };
  }
  return {
    channel: "slack",
    client: { contacts: book.contacts, slack },
    identity: { id: AGENT, agentHandle: HANDLE },
    replies,
    lookups: book.lookups,
    peers: Object.fromEntries(
      Object.entries(chats).map(([chat, [, user]]) => [chat, "TTEAM:" + user]),
    ),
    event,
  };
}

// Tasks from another agent. `chat` is the task ID; each event adds the
// caller's next message to that task.
export function a2aFixture(options) {
  const { replies, book } = shared(options);
  const caller = { identityId: "peer-agent", handle: "peer" };
  const tasks = new Map();
  const identity = {
    id: AGENT,
    agentHandle: HANDLE,
    async a2aTask(id) {
      return tasks.get(id);
    },
    async a2aReply(id, outcome) {
      const task = tasks.get(id);
      replies.push({ channel: "a2a", conversationId: id, ...outcome });
      task.state =
        outcome.intent === "ask_caller"
          ? "input-required"
          : outcome.intent === "fail"
            ? "failed"
            : "completed";
      return { id, state: task.state };
    },
  };
  function event(id, chat, text, _threadRoot, extra = {}) {
    if (!tasks.has(chat))
      tasks.set(chat, {
        id: chat,
        contextId: "context-" + chat,
        state: "working",
        caller,
        target: { identityId: AGENT },
        messages: [],
      });
    const task = tasks.get(chat);
    task.state = "working";
    task.messages.push({ messageId: id, role: "caller", parts: [{ text }] });
    return {
      id,
      event_type:
        task.messages.length === 1 ? "a2a.task.created" : "a2a.task.message",
      data: {
        task_id: chat,
        context_id: task.contextId,
        message_id: id,
        caller: { identity_id: caller.identityId, handle: caller.handle },
        parts: [{ text }],
        ...extra,
      },
    };
  }
  return {
    channel: "a2a",
    client: { contacts: book.contacts },
    identity,
    replies,
    lookups: book.lookups,
    peers: { caller: caller.handle },
    event,
  };
}

/**
 * One identity reachable on several channels, with one reply log and one
 * address book. Each entry of `factories` receives the shared options, e.g.
 * `combineFixtures([smsFixture, emailFixture], { directory })`. The parts
 * (and their `event` functions) are under `channels` by channel name.
 */
export function combineFixtures(factories, options) {
  const common = shared(options);
  const parts = factories.map((make) => make(common));
  return {
    client: Object.assign({}, ...parts.map((part) => part.client)),
    identity: Object.assign({}, ...parts.map((part) => part.identity)),
    replies: common.replies,
    lookups: common.book.lookups,
    channels: Object.fromEntries(parts.map((part) => [part.channel, part])),
  };
}
