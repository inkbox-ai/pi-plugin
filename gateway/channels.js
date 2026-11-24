import { createHash } from "node:crypto";

export const digest = (...fields) => createHash("sha256").update(JSON.stringify(fields)).digest("hex");
const clean = (s) => typeof s === "string" ? s.trim() : "";
const directAccess = (message) => message?.sender_access == null || message.sender_access === "direct";
const normalized = (s) => clean(s).toLowerCase();
const slackEvents = ["slack.dm_received", "slack.mention_received", "slack.group_dm_received", "slack.thread_reply_received"];
const taskEvents = ["a2a.task.created", "a2a.task.message"];

function mediaDescription(media) {
  if (!Array.isArray(media) || media.length === 0) return "";
  return "Attachments: " + media.slice(0, 20).map((item) => item?.filename || item?.content_type || "attachment").join(", ");
}

/** The event envelope is authenticated before this function is called. Routes are never taken from model output. */
export function parseRoute(event, identity, allowedSenders = []) {
  const data = event?.data;
  if (!data || !clean(event.id) || event.id.length > 256) return null;
  let callerId, channel, sender, text, conversation, message, subthread, connection, workspace, status;
  if (event.companion && event.companion.phase !== "ordinary") return null;
  if (slackEvents.includes(event.event_type)) {
    if (data.identity_id !== identity.id || !directAccess(data) || data.actor_profile?.is_bot ||
      data.event?.app_id || data.event?.bot_id || data.event?.subtype === "bot_message") return null;
    if (!clean(data.actor_id) || !clean(data.message_ts)) return null;
    channel = "slack";
    connection = clean(data.connection_id);
    workspace = clean(data.workspace_id);
    if (!connection || !workspace) return null;
    sender = workspace + ":" + data.actor_id;
    conversation = clean(data.conversation_id);
    subthread = clean(data.thread_ts) || (event.event_type === "slack.mention_received" ? data.message_ts : "");
    message = data.message_ts;
    text = [data.event?.text, mediaDescription(data.event?.files)].filter(Boolean).join("\n");
    if (event.event_type === "slack.thread_reply_received") status = "existing-thread";
  } else if (taskEvents.includes(event.event_type)) {
    channel = "a2a";
    callerId = clean(data.caller?.identity_id);
    if (!callerId) return null;
    if (data.caller?.identity_id === identity.id || (data.sender && data.sender.identity_id !== data.caller?.identity_id)) return null;
    sender = clean(data.caller?.handle);
    conversation = clean(data.task_id);
    message = clean(data.message_id) || event.id;
    text = (Array.isArray(data.parts) ? data.parts : []).map((part) => clean(part?.text)).filter(Boolean).join("\n");
    // Task-created events can contain just a reference. Read the task from the authenticated identity.
    if (!text) text = "[Task message]";
  } else {
    const record = event.event_type === "text.received" ? data.text_message : data.message;
    if (!record || record.direction !== "inbound" || !directAccess(record)) return null;
    message = clean(record.id);
    const media = mediaDescription(record.media);
    switch (event.event_type) {
      case "message.received":
        if (!identity.mailbox || record.mailbox_id !== identity.mailbox.id) return null;
        channel = "email";
        sender = clean(record.from_address);
        conversation = clean(record.thread_id) || message;
        text = [record.subject, record.body ?? record.snippet, record.has_attachments && "Attachments included"].filter(Boolean).join("\n");
        break;
      case "text.received":
        if (!identity.phoneNumber || record.local_phone_number !== identity.phoneNumber.number || record.origin === "auto_reply") return null;
        channel = "sms";
        sender = clean(record.sender_phone_number) || clean(record.remote_phone_number);
        conversation = clean(record.conversation_id);
        text = [record.text, media].filter(Boolean).join("\n");
        break;
      case "imessage.received":
        if (!identity.imessageEnabled) return null;
        channel = "imessage";
        sender = clean(record.sender_number) || clean(record.remote_number);
        conversation = clean(record.conversation_id);
        subthread = clean(record.thread_root_message_id) || clean(record.thread_id);
        text = [record.content, media].filter(Boolean).join("\n");
        break;
      case "whatsapp.received":
        if (record.agent_identity_id !== identity.id) return null;
        channel = "whatsapp";
        sender = clean(record.sender_number) || clean(record.remote_number);
        conversation = clean(record.conversation_id);
        subthread = clean(record.thread_root_message_id) || clean(record.thread_id);
        text = [record.content, media].filter(Boolean).join("\n");
        break;
      default:
        return null;
    }
    if ([identity.emailAddress, identity.phoneNumber?.number, identity.whatsappNumber, identity.imessageNumber?.number]
      .some((address) => normalized(address) && normalized(address) === normalized(sender))) return null;
  }
  if (channel === "sms" && ["stop", "cancel", "end", "quit", "unsubscribe", "help", "start", "unstop", "stopall"].includes(normalized(text))) return null;
  if (!sender || !message || !conversation || !clean(text)) return null;
  if (allowedSenders.length && !allowedSenders.some((allowed) => normalized(allowed) === normalized(sender))) return null;
  const thread = digest(channel, connection, conversation, subthread || null);
  return { callerId, channel, sender, thread, conversation, message, text, subthread, connection, workspace, status };
}

export async function beforeTurn(route, client, identity) {
  if (route.channel === "slack") {
    const { connections } = await client.slack.listConnections(identity.id);
    const connection = connections.find((entry) => entry.id === route.connection && entry.identityId === identity.id &&
      entry.workspaceId === route.workspace && entry.status === "connected");
    if (!connection || route.sender === route.workspace + ":" + connection.botUserId) return false;
    if (route.generation !== undefined && connection.generation !== route.generation) return false;
    route.generation = connection.generation;
  }
  if (route.channel === "a2a") {
    const task = await identity.a2aTask(route.conversation);
    if ((task.target && task.target.identityId !== identity.id) || task.caller?.identityId !== route.callerId) return false;
    if (!["submitted", "working"].includes(task.state)) return false;
    if (route.text === "[Task message]") {
      const messages = task.messages ?? task.history ?? [];
      const latest = messages.filter((entry) => entry.role === "user").at(-1);
      route.text = latest?.parts?.map((part) => clean(part.text)).filter(Boolean).join("\n");
      if (!route.text) return false;
    }
  }
  return true;
}

export async function sendReply(route, text, idempotencyKey, client, identity) {
  switch (route.channel) {
    case "email": return identity.replyAllEmail(route.message, { bodyText: text, idempotencyKey });
    case "sms": return identity.sendText({ conversationId: route.conversation, text, idempotencyKey });
    case "imessage": return identity.sendIMessage({ conversationId: route.conversation, replyToMessageId: route.message, text, idempotencyKey });
    case "whatsapp": return identity.sendWhatsApp({ conversationId: route.conversation, replyToMessageId: route.message, text, idempotencyKey });
    case "slack": {
      if (!await beforeTurn(route, client, identity)) throw new Error("Slack destination changed.");
      const action = await client.slack.sendMessage(route.connection, {
        conversationId: route.conversation, threadTs: route.subthread || null, text, idempotencyKey
      });
      if (action.status !== "sent") throw new Error("Slack send not confirmed.");
      return action;
    }
    case "a2a":
      if (await beforeTurn(route, client, identity)) return identity.a2aReply(route.conversation, { intent: "complete", text });
      return;
    default: throw new Error("Unknown reply channel.");
  }
}

export async function subscribe(client, identity, url) {
  const owners = [];
  if (identity.mailbox) owners.push([{ mailboxId: identity.mailbox.id }, ["message.received"]]);
  if (identity.phoneNumber) owners.push([{ phoneNumberId: identity.phoneNumber.id }, ["text.received"]]);
  const identityEvents = [...taskEvents, ...slackEvents];
  if (identity.imessageEnabled) identityEvents.push("imessage.received");
  if (identity.whatsappNumber) identityEvents.push("whatsapp.received");
  owners.push([{ agentIdentityId: identity.id }, identityEvents]);
  const subscriptions = client.webhooks.subscriptions;
  for (const [owner, eventTypes] of owners) {
    const scope = owner.agentIdentityId ? { scope: "identity" } : {};
    const list = await subscriptions.list({ ...owner, ...scope, url });
    const same = list.filter((sub) => sub.url === url);
    if (same.some((sub) => sub.status !== "active" && sub.eventTypes.some((t) => eventTypes.includes(t)))) {
      throw new Error("An existing gateway subscription is paused; resume it before starting.");
    }
    const covered = new Set(same.flatMap((sub) => sub.eventTypes));
    const missing = eventTypes.filter((type) => !covered.has(type));
    if (!missing.length) continue;
    if (same.length && !owner.agentIdentityId) {
      const row = same[0];
      await subscriptions.update(row.id, { eventTypes: [...new Set([...row.eventTypes, ...missing])] });
    } else {
      await subscriptions.create({ ...owner, url, eventTypes: missing });
    }
  }
}
