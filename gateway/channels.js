import { parseA2AOutcome } from "../extension/a2a-outcome.js";
import { createHash } from "node:crypto";
import {
  companionScope,
  companionStillActive,
  mentionsAgent,
  prepareCompanion,
} from "./companion.js";

export const digest = (...fields) =>
  createHash("sha256").update(JSON.stringify(fields)).digest("hex");
const clean = (s) => (typeof s === "string" ? s.trim() : "");
const eligibleAccess = (access, envelope, options) =>
  (access == null && !envelope) ||
  access === "direct" ||
  (access === "sponsored" &&
    ["live", "initialization"].includes(envelope?.phase) &&
    options.companionResponseMode === "relaxed");
const normalized = (s) => clean(s).toLowerCase();
const slackEvents = [
  "slack.dm_received",
  "slack.mention_received",
  "slack.group_dm_received",
  "slack.channel_message_received",
  "slack.thread_reply_received",
];
const taskEvents = ["a2a.task.created", "a2a.task.message"];

function mediaDescription(media) {
  if (!Array.isArray(media) || media.length === 0) return "";
  return (
    "Attachments: " +
    media
      .slice(0, 20)
      .map((item) => item?.filename || item?.content_type || "attachment")
      .join(", ")
  );
}

/** The event envelope is authenticated before this function is called. Routes are never taken from model output. */
export function parseRoute(event, identity, allowedSenders = [], options = {}) {
  const data = event?.data;
  if (!data || !clean(event.id) || event.id.length > 256) return null;
  if (
    options.outbound?.approval === "allowlist" &&
    !options.outbound?.allowedRecipients?.length
  )
    return null;
  let callerId,
    channel,
    sender,
    text,
    conversation,
    message,
    subthread,
    connection,
    workspace,
    status;
  let record,
    group = false,
    addressed = false,
    archivedMessage,
    generation,
    actor,
    contextId,
    recipients,
    control;
  if (
    event.companion != null &&
    !["ordinary", "initialization", "live"].includes(event.companion.phase)
  )
    return null;
  if (slackEvents.includes(event.event_type)) {
    if (
      data.identity_id !== identity.id ||
      !eligibleAccess(data.sender_access, event.companion, options) ||
      data.actor_profile?.is_bot ||
      data.event?.app_id ||
      data.event?.bot_id ||
      data.event?.subtype === "bot_message"
    )
      return null;
    if (!clean(data.actor_id) || !clean(data.message_ts)) return null;
    channel = "slack";
    connection = clean(data.connection_id);
    workspace = clean(data.workspace_id);
    if (!connection || !workspace) return null;
    actor = data.actor_id;
    const profile = data.actor_profile;
    sender =
      (profile?.id === actor && clean(profile.team_id)
        ? profile.team_id
        : workspace) +
      ":" +
      actor;
    generation = data.connection_generation;
    archivedMessage = clean(data.message_id);
    if (
      generation != null &&
      (!Number.isSafeInteger(generation) || generation < 0)
    )
      return null;
    const kinds = Array.isArray(data.message_kinds) ? data.message_kinds : [];
    addressed =
      kinds.includes("dm") ||
      kinds.includes("mention") ||
      ["slack.mention_received", "slack.dm_received"].includes(
        event.event_type,
      );
    group = !kinds.includes("dm") && event.event_type !== "slack.dm_received";
    if (
      event.event_type === "slack.channel_message_received" &&
      !addressed &&
      !event.companion &&
      !data.thread_ts
    )
      return null;
    conversation = clean(data.conversation_id);
    subthread =
      clean(data.thread_ts) ||
      (group && !event.companion ? data.message_ts : "");
    message = data.message_ts;
    text = [data.event?.text, mediaDescription(data.event?.files)]
      .filter(Boolean)
      .join("\n");
    if (
      !addressed &&
      !event.companion &&
      [
        "slack.thread_reply_received",
        "slack.channel_message_received",
      ].includes(event.event_type)
    )
      status = "existing-thread";
  } else if (taskEvents.includes(event.event_type)) {
    channel = "a2a";
    callerId = clean(data.caller?.identity_id);
    if (!callerId) return null;
    if (
      data.caller?.identity_id === identity.id ||
      (data.sender && data.sender.identity_id !== data.caller?.identity_id)
    )
      return null;
    sender = clean(data.caller?.handle);
    conversation = clean(data.task_id);
    message = clean(data.message_id);
    contextId = clean(data.context_id);
    if (!message || !contextId) return null;
    text = (Array.isArray(data.parts) ? data.parts : [])
      .map((part) => clean(part?.text))
      .filter(Boolean)
      .join("\n");
    // Task-created events can contain just a reference. Read the task from the authenticated identity.
    if (!text) text = "[Task message]";
  } else {
    record =
      event.event_type === "text.received" ? data.text_message : data.message;
    if (
      !record ||
      record.direction !== "inbound" ||
      !eligibleAccess(record.sender_access, event.companion, options)
    )
      return null;
    message = clean(record.id);
    const media = mediaDescription(record.media);
    group = record.is_group === true || (record.participants?.length ?? 0) > 2;
    recipients = record.participants;
    if (Array.isArray(record.recipients) && record.recipients.length > 1)
      group = true;
    switch (event.event_type) {
      case "message.received":
        if (!identity.mailbox || record.mailbox_id !== identity.mailbox.id)
          return null;
        channel = "email";
        sender = clean(record.from_address);
        conversation = clean(record.thread_id) || message;
        text =
          [
            record.subject,
            record.body ?? record.snippet,
            record.has_attachments && "Attachments included",
          ]
            .filter(Boolean)
            .join("\n") || "[Email]";
        const addresses = [
          ...(record.to_addresses ?? []),
          ...(record.cc_addresses ?? []),
        ];
        group = addresses.length > 1;
        addressed = (record.to_addresses ?? []).some(
          (a) =>
            normalized(a).replace(/^.*<([^>]+)>$/, "$1") ===
            normalized(identity.mailbox.emailAddress),
        );
        control = clean(record.body);
        break;
      case "text.received":
        if (
          !identity.phoneNumber ||
          record.local_phone_number !== identity.phoneNumber.number ||
          record.origin === "auto_reply"
        )
          return null;
        channel = "sms";
        sender =
          clean(record.sender_phone_number) ||
          clean(record.remote_phone_number);
        conversation = clean(record.conversation_id);
        text = [record.text, media].filter(Boolean).join("\n");
        break;
      case "imessage.received":
        if (!identity.imessageEnabled) return null;
        channel = "imessage";
        sender = clean(record.sender_number) || clean(record.remote_number);
        conversation = clean(record.conversation_id);
        subthread =
          clean(record.thread_root_message_id) || clean(record.thread_id);
        text = [record.content, media].filter(Boolean).join("\n");
        break;
      case "whatsapp.received":
        if (record.agent_identity_id !== identity.id) return null;
        channel = "whatsapp";
        sender = clean(record.sender_number) || clean(record.remote_number);
        conversation = clean(record.conversation_id);
        subthread =
          clean(record.thread_root_message_id) || clean(record.thread_id);
        text = [record.content, media].filter(Boolean).join("\n");
        break;
      default:
        return null;
    }
    if (
      [
        identity.emailAddress,
        identity.phoneNumber?.number,
        identity.whatsappNumber,
        identity.imessageNumber?.number,
      ].some(
        (address) =>
          normalized(address) && normalized(address) === normalized(sender),
      )
    )
      return null;
  }
  if (
    channel === "sms" &&
    [
      "stop",
      "cancel",
      "end",
      "quit",
      "unsubscribe",
      "help",
      "start",
      "unstop",
      "stopall",
    ].includes(normalized(text))
  )
    return null;
  if (!sender || !message || !conversation || !clean(text)) return null;
  const sponsored = (record ?? data).sender_access === "sponsored";
  // A sponsored participant can speak only inside the activated scope. Their
  // admission depends on the current snapshot sponsor, not a reusable sender grant.
  if (
    !sponsored &&
    channel !== "slack" &&
    allowedSenders.length &&
    !allowedSenders.some(
      (allowed) => normalized(allowed) === normalized(sender),
    )
  )
    return null;
  const route = {
    callerId,
    contextId,
    channel,
    sender,
    conversation,
    message,
    text,
    subthread,
    connection,
    workspace,
    status,
    generation,
    actor,
    group,
    archivedMessage,
    control,
    sponsored,
    allowedSenders,
    recipients,
    allowedRecipients: options.outbound?.allowedRecipients ?? [],
  };
  if (
    route.channel === "slack" &&
    !route.subthread &&
    event.event_type === "slack.thread_reply_received"
  )
    return null;
  if (event.companion != null) {
    route.companion = companionScope(event.companion, route);
    if (!route.companion) return null;
    route.sequence = event.companion.sequence;
    route.group = true;
  }
  route.noControls =
    route.group ||
    Boolean(route.companion) ||
    route.channel === "a2a" ||
    (channel === "slack" && allowedSenders.length > 0);
  if (
    route.group &&
    options.groupReplyMode === "mention" &&
    !addressed &&
    !record?.agent_mentioned &&
    !mentionsAgent(
      record?.content ?? record?.text ?? record?.body ?? text,
      identity.agentHandle,
    )
  )
    return null;
  route.thread = route.companion
    ? digest(
        channel,
        connection,
        route.companion.conversation,
        route.companion.id,
        route.companion.activation,
      )
    : digest(channel, connection, conversation, subthread || null);
  return route;
}

function recipientsAllowed(route, recipients, own) {
  const policies = [route.allowedRecipients];
  if (route.group && !route.companion?.activation && route.channel !== "slack")
    policies.push(route.allowedSenders);
  const restricted = policies.filter((list) => list?.length);
  if (!restricted.length) return true;
  if (
    !Array.isArray(recipients) ||
    recipients.some((value) => typeof value !== "string" || !value.trim())
  )
    return false;
  const external = recipients
    .map(normalized)
    .filter((r) => !own.map(normalized).includes(r));
  return (
    external.length > 0 &&
    restricted.every((list) =>
      external.every((r) => list.some((value) => normalized(value) === r)),
    )
  );
}

async function slackSource(route, client, identity) {
  const { connections } = await client.slack.listConnections(identity.id);
  const active = connections.filter(
    (c) =>
      c.id === route.connection &&
      c.identityId === identity.id &&
      c.workspaceId === route.workspace &&
      c.status === "connected",
  );
  if (
    active.length !== 1 ||
    active[0].botUserId === route.actor ||
    (route.generation != null && active[0].generation !== route.generation)
  )
    return false;
  route.generation = active[0].generation;
  if (route.companion || route.allowedSenders.length) {
    const profile = await client.slack.getUser(route.connection, route.actor);
    if (profile?.id !== route.actor || !profile.team_id || profile.is_bot)
      return false;
    route.sender = profile.team_id + ":" + route.actor;
    if (
      !route.sponsored &&
      route.allowedSenders.length &&
      !route.allowedSenders.some(
        (a) => normalized(a) === normalized(route.sender),
      )
    )
      return false;
  }
  if (route.companion) {
    const match = /^(\d{1,12})\.(\d{1,6})$/.exec(route.message);
    if (!match) return false;
    const ticks = BigInt(match[1]) * 1000000n + BigInt(match[2].padEnd(6, "0"));
    const ts = (n) =>
      String(n / 1000000n) + "." + String(n % 1000000n).padStart(6, "0");
    const page = await client.slack.listArchivedMessages(route.connection, {
      conversationId: route.conversation,
      afterTs: ts(ticks - 1n),
      beforeTs: ts(ticks + 1n),
      limit: 2,
    });
    const source = page.messages[0];
    if (
      page.nextCursor ||
      page.messages.length !== 1 ||
      !source?.id ||
      source.connectionId !== route.connection ||
      source.conversationId !== route.conversation ||
      source.messageTs !== route.message ||
      source.userId !== route.actor ||
      source.source !== "event" ||
      (route.archivedMessage && route.archivedMessage !== source.id) ||
      (source.threadTs === source.messageTs ? "" : (source.threadTs ?? "")) !==
        (route.subthread === route.message ? "" : (route.subthread ?? ""))
    )
      return false;
    route.archivedMessage = source.id;
  }
  return recipientsAllowed(
    route,
    ["slack:" + route.connection + ":" + route.conversation],
    [],
  );
}

async function taskSource(route, identity) {
  const task = await identity.a2aTask(route.conversation);
  if (
    task.id !== route.conversation ||
    task.contextId !== route.contextId ||
    task.target?.identityId !== identity.id ||
    task.caller?.identityId !== route.callerId ||
    normalized(task.caller?.handle) !== normalized(route.sender) ||
    !["submitted", "working"].includes(task.state)
  )
    return false;
  const latest = task.messages?.at(-1);
  if (
    !latest ||
    !["caller", "user", "ROLE_USER"].includes(latest.role) ||
    latest.messageId !== route.message
  )
    return false;
  route.text = latest.parts
    .map((part) => clean(part.text))
    .filter(Boolean)
    .join("\n");
  return Boolean(route.text);
}

async function messagingSource(route, identity) {
  if (route.channel === "email") {
    const source = await identity.getMessage(route.message);
    if (
      source.id !== route.message ||
      source.direction !== "inbound" ||
      source.mailboxId !== identity.mailbox.id ||
      (source.threadId || source.id) !== route.conversation ||
      normalized(source.fromAddress) !== normalized(route.sender)
    )
      return false;
    route.text = [
      source.subject,
      source.bodyText ?? source.bodyHtml,
      mediaDescription(source.attachmentMetadata),
    ]
      .filter(Boolean)
      .join("\n");
    const recipients = source.replyAllRecipients;
    route.replyRecipients = recipients && [...recipients.to, ...recipients.cc];
    return (
      Boolean(route.text) &&
      recipientsAllowed(route, route.replyRecipients, [
        identity.mailbox.emailAddress,
      ])
    );
  }
  if (route.channel === "imessage" || route.channel === "whatsapp") {
    const whatsapp = route.channel === "whatsapp";
    const source = whatsapp
      ? await identity.getWhatsAppMessage(route.message)
      : await identity.getIMessage(route.message);
    if (
      source.id !== route.message ||
      source.conversationId !== route.conversation ||
      source.direction !== "inbound" ||
      (whatsapp && source.agentIdentityId !== identity.id) ||
      (source.senderNumber || source.remoteNumber) !== route.sender ||
      (source.threadRootMessageId || source.threadId || "") !==
        (route.subthread || "")
    )
      return false;
    if (route.group || source.isGroup || route.allowedRecipients?.length) {
      const destination = whatsapp
        ? await identity.getWhatsAppConversation(route.conversation)
        : await identity.getIMessageConversation(route.conversation);
      if (
        destination.id !== route.conversation ||
        (source.isGroup === true && destination.isGroup !== true) ||
        (destination.isGroup &&
          (!Array.isArray(destination.participants) ||
            !destination.participants.includes(route.sender) ||
            destination.participants.some(
              (p) => !/^\+[1-9]\d{6,14}$/.test(p),
            ))) ||
        (whatsapp &&
          (destination.agentIdentityId !== identity.id ||
            destination.unresolvedParticipantCount > 0)) ||
        !recipientsAllowed(
          route,
          destination.isGroup
            ? destination.participants
            : [destination.remoteNumber],
          [identity.whatsappNumber, identity.imessageNumber?.number],
        )
      )
        return false;
    }
    return true;
  }
  if (
    route.channel === "sms" &&
    (route.allowedRecipients?.length ||
      (route.group &&
        !route.companion?.activation &&
        route.allowedSenders.length))
  ) {
    // A remote participant list can change. For restricted replies, do not rely
    // on an old webhook snapshot to authorize sending into a group.
    const source = await identity.getText(route.message);
    if (
      source.id !== route.message ||
      source.conversationId !== route.conversation ||
      source.direction !== "inbound" ||
      source.localPhoneNumber !== identity.phoneNumber.number ||
      (source.senderPhoneNumber || source.remotePhoneNumber) !== route.sender
    )
      return false;
    if (route.group || source.recipients?.length > 1) {
      // Select the exact current group, never a contact or the first matching telephone number.
      const page = await identity.listTextConversations({
        participants: [route.sender],
        includeGroups: true,
        limit: 200,
      });
      const matches = page.filter((item) => item.id === route.conversation);
      return (
        matches.length === 1 &&
        matches[0].isGroup &&
        matches[0].participants?.includes(route.sender) &&
        recipientsAllowed(route, matches[0].participants, [
          identity.phoneNumber.number,
        ])
      );
    }
    return recipientsAllowed(route, [route.sender], []);
  }
  return true;
}

export async function beforeTurn(
  route,
  client,
  identity,
  { hasSession = false } = {},
) {
  if (route.channel === "a2a") return taskSource(route, identity);
  if (route.channel === "slack") {
    if (!(await slackSource(route, client, identity))) return false;
  } else if (!(await messagingSource(route, identity))) return false;
  return prepareCompanion(route, client, identity, hasSession);
}

export async function sendReply(route, text, idempotencyKey, client, identity) {
  if (!(await companionStillActive(route, client, identity)))
    throw new Error("Companion reply scope has changed.");
  if (
    route.channel !== "a2a" &&
    route.channel !== "slack" &&
    !(await messagingSource(route, identity))
  )
    throw new Error("Message destination changed.");
  switch (route.channel) {
    case "email": {
      const parent = route.companionReply?.replyToMessageId ?? route.message;
      if (route.companionReply) {
        const source = await identity.getMessage(parent);
        const audience = source.replyAllRecipients;
        const equal = (a, b) =>
          Array.isArray(a) &&
          Array.isArray(b) &&
          JSON.stringify(a.map(normalized).sort()) ===
            JSON.stringify(b.map(normalized).sort());
        if (
          source.id !== parent ||
          source.threadId !== route.conversation ||
          source.mailboxId !== identity.mailbox.id ||
          !equal(audience?.to, route.companionReply.to ?? []) ||
          !equal(audience?.cc, route.companionReply.cc ?? []) ||
          !recipientsAllowed(
            route,
            [...audience.to, ...audience.cc],
            [identity.mailbox.emailAddress],
          )
        )
          throw new Error("Email recipients changed.");
      }
      return identity.replyAllEmail(parent, { bodyText: text, idempotencyKey });
    }
    case "sms":
      return identity.sendText({
        conversationId: route.conversation,
        text,
        idempotencyKey,
      });
    case "imessage":
      return identity.sendIMessage({
        conversationId: route.conversation,
        replyToMessageId: route.message,
        text,
        idempotencyKey,
      });
    case "whatsapp":
      return identity.sendWhatsApp({
        conversationId: route.conversation,
        replyToMessageId: route.message,
        text,
        idempotencyKey,
      });
    case "slack": {
      if (!(await slackSource(route, client, identity)))
        throw new Error("Slack destination changed.");
      const action = await client.slack.sendMessage(route.connection, {
        conversationId: route.conversation,
        threadTs: route.subthread || null,
        text,
        idempotencyKey,
      });
      if (action.status !== "sent")
        throw new Error("Slack send not confirmed.");
      return action;
    }
    case "a2a":
      if (await taskSource(route, identity))
        return identity.a2aReply(route.conversation, parseA2AOutcome(text));
      return;
    default:
      throw new Error("Unknown reply channel.");
  }
}

export async function subscribe(client, identity, url) {
  const owners = [];
  if (identity.mailbox)
    owners.push([
      { mailboxId: identity.mailbox.id },
      ["message.received", "message.failed", "message.bounced"],
    ]);
  if (identity.phoneNumber)
    owners.push([
      { phoneNumberId: identity.phoneNumber.id },
      ["text.received", "text.delivery_failed", "text.delivery_unconfirmed"],
    ]);
  const identityEvents = [...taskEvents, ...slackEvents];
  if (identity.imessageEnabled)
    identityEvents.push("imessage.received", "imessage.delivery_failed");
  if (identity.whatsappEnabled || identity.whatsappNumber)
    identityEvents.push(
      "whatsapp.received",
      "whatsapp.delivery_failed",
      "whatsapp.delivery_unconfirmed",
    );
  owners.push([{ agentIdentityId: identity.id }, identityEvents]);
  const subscriptions = client.webhooks.subscriptions;
  for (const [owner, eventTypes] of owners) {
    const scope = owner.agentIdentityId ? { scope: "identity" } : {};
    const list = await subscriptions.list({ ...owner, ...scope, url });
    const same = list.filter((sub) => sub.url === url);
    if (
      same.some(
        (sub) =>
          sub.status !== "active" &&
          sub.eventTypes.some((t) => eventTypes.includes(t)),
      )
    ) {
      throw new Error(
        "An existing gateway subscription is paused; resume it before starting.",
      );
    }
    const covered = new Set(same.flatMap((sub) => sub.eventTypes));
    const missing = eventTypes.filter((type) => !covered.has(type));
    if (!missing.length) continue;
    if (same.length && !owner.agentIdentityId) {
      const row = same[0];
      await subscriptions.update(row.id, {
        eventTypes: [...new Set([...row.eventTypes, ...missing])],
      });
    } else {
      await subscriptions.create({ ...owner, url, eventTypes: missing });
    }
  }
}
