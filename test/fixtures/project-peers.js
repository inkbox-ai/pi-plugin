import assert from "node:assert/strict";

// Source reads are kept separate from verified event envelopes: the gateway
// must resolve the actual SDK message, participants and destination itself.
export function nativePhoneFixture(channel) {
  const owner = "+12025550102",
    other = "+12025550103";
  const sources = new Map();
  const peers = { "owners-chat": owner, "other-chat": other };
  const replies = [];
  const line = "+12025550101";
  const metadata = {
    agentIdentityId: "agent",
    localNumber: line,
    unresolvedParticipantCount: 0,
  };
  const topRoot = (id) => (channel === "imessage" ? id : null);
  const identity = {
    id: "agent",
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
        isGroup: false,
        remoteNumber: peer,
        participants: [peer],
        assignmentId: null,
      };
    },
    async [channel === "imessage" ? "sendIMessage" : "sendWhatsApp"](message) {
      if (message.replyToMessageId) {
        const parent = sources.get(message.replyToMessageId);
        parent.threadRootMessageId ??= parent.id;
      }
      replies.push(message);
      return { id: "reply-" + replies.length };
    },
  };
  function event(id, chat, text, threadRoot) {
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
      },
    };
  }
  return {
    client: {},
    identity,
    replies,
    event,
    grants: Object.entries(peers).map(
      ([chat, peer]) => channel + ":" + chat + ":" + peer,
    ),
  };
}

export function smsFixture() {
  const line = "+12025550101";
  const peers = { "owners-chat": "+12025550102", "other-chat": "+12025550103" };
  const sources = new Map(),
    replies = [];
  const identity = {
    id: "agent",
    phoneNumber: { id: "phone", number: line },
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
      const [chat] = Object.entries(peers).find(
        ([, peer]) => peer === message.to,
      );
      assert.equal(
        message.conversationId,
        undefined,
        "Project SMS must pin its recipient",
      );
      replies.push({ ...message, conversationId: chat });
      return {
        id: "sms-" + replies.length,
        conversationId: chat,
        direction: "outbound",
        remotePhoneNumber: message.to,
        ...message,
      };
    },
  };
  function event(id, chat, text) {
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
      },
    };
  }
  return {
    client: {},
    identity,
    replies,
    event,
    grants: Object.entries(peers).map(
      ([chat, peer]) => "sms:" + chat + ":" + peer,
    ),
  };
}

export function emailFixture() {
  const own = "agent@example.test";
  const peers = {
    "owners-chat": "owner@example.test",
    "other-chat": "other@example.test",
  };
  const sources = new Map(),
    replies = [];
  const identity = {
    id: "agent",
    mailbox: { id: "mailbox", emailAddress: own, agentIdentityId: "agent" },
    async getMessage(id) {
      return sources.get(id);
    },
    async getThread(id) {
      const messages = [...sources.values()].filter((m) => m.threadId === id);
      return {
        id,
        mailboxId: "mailbox",
        folder: "inbox",
        subject: "Project work",
        messageCount: messages.length,
        messages,
      };
    },
    async sendEmail(message) {
      const source = [...sources.values()].find(
        (m) => m.messageId === message.inReplyToMessageId,
      );
      assert.ok(
        source,
        "Project mail must reply to the verified RFC message ID",
      );
      const chat = source.threadId,
        peer = peers[chat];
      assert.deepEqual(message.to, [peer]);
      assert.ok(!message.cc?.length && !message.bcc?.length);
      const id = "outbound-" + (replies.length + 1);
      replies.push({
        conversationId: chat,
        text: message.bodyText,
        idempotencyKey: message.idempotencyKey,
      });
      const sent = {
        id,
        mailboxId: "mailbox",
        threadId: chat,
        messageId: "<" + id + "@example.test>",
        direction: "outbound",
        fromAddress: own,
        toAddresses: [peer],
        ccAddresses: null,
        bccAddresses: null,
        status: "sent",
        subject: message.subject,
        bodyText: message.bodyText,
        importJobId: null,
      };
      sources.set(id, sent);
      return sent;
    },
  };
  function event(id, chat, text) {
    const peer = peers[chat];
    const previous = [...sources.values()].findLast(
      (m) => m.threadId === chat && m.direction === "outbound",
    );
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
      bodyText: null,
      bodyHtml:
        "<p>" +
        text.replaceAll("&", "&amp;").replaceAll("<", "&lt;") +
        "</p><blockquote>Earlier correspondence</blockquote>",
      attachmentMetadata: null,
      hasAttachments: false,
      inReplyTo: previous?.messageId ?? null,
      references: previous ? [previous.messageId] : null,
      replyAllRecipients: { to: [peer], cc: [] },
      importJobId: null,
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
          body: text + " Earlier correspondence",
        },
      },
    };
  }
  return {
    client: {},
    identity,
    replies,
    event,
    grants: Object.entries(peers).map(
      ([chat, peer]) => "email:" + chat + ":" + peer,
    ),
  };
}

export function slackFixture() {
  const connection = {
    id: "conn",
    identityId: "agent",
    workspaceId: "TTEAM",
    generation: 1,
    status: "connected",
    botUserId: "UBOT",
  };
  const chats = {
    "owners-chat": ["DOWNER", "UOWNER"],
    "other-chat": ["DOTHER", "UOTHER"],
  };
  const sources = new Map(),
    replies = [];
  const slack = {
    async listConnections() {
      return { connections: [connection] };
    },
    async getUser(_, id) {
      return { id, team_id: "TTEAM", is_bot: false };
    },
    async getConversation(_, id) {
      const [, user] = Object.values(chats).find(
        ([conversation]) => conversation === id,
      );
      return { id, is_im: true, user };
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
      assert.equal(connectionId, connection.id);
      const [chat] = Object.entries(chats).find(
        ([, [id]]) => id === message.conversationId,
      );
      replies.push({ ...message, conversationId: chat });
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
  function event(id, chat, text, threadRoot) {
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
        identity_id: "agent",
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
      },
    };
  }
  return {
    client: { slack },
    identity: { id: "agent" },
    event,
    replies,
    grants: Object.values(chats).map(
      ([dm, user]) => "slack:conn:" + dm + ":TTEAM:" + user,
    ),
  };
}
