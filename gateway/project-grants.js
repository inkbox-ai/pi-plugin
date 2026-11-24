import { createHash, randomUUID } from "node:crypto";

import { authoredHtmlText } from "./mail-html.js";
import { archivedSlackSource, findTextConversation } from "./source-lookups.js";

const directGrant =
  /^(?:(?:imessage|whatsapp|sms):[^:\s]+:\+[1-9]\d{6,14}|email:[^:\s]+:[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+|slack:[^:\s]+:D[A-Z0-9]+:[A-Z0-9]+:[A-Z0-9]+)$/;

export function validateProjectConfig(config) {
  if (
    !Array.isArray(config.trustedConversations ?? []) ||
    (config.trustedConversations ?? []).some(
      (key) => typeof key !== "string" || !directGrant.test(key),
    )
  )
    throw new Error(
      "Invalid trustedConversations binding. Use channel:conversation:peer, or slack:connection:DM:team:user.",
    );
  if (
    config.projectReadWorkspace !== undefined &&
    typeof config.projectReadWorkspace !== "boolean"
  )
    throw new Error("projectReadWorkspace must be a boolean.");
  const argv = config.projectTestCommand;
  if (
    argv !== undefined &&
    (!Array.isArray(argv) ||
      argv.some((v) => typeof v !== "string" || v.includes("\0")) ||
      (argv.length > 0 && !argv[0].trim()))
  )
    throw new Error(
      "projectTestCommand must be a JSON argument array with a non-empty executable.",
    );
}

export function projectAudience(route) {
  return route.channel === "slack"
    ? "slack:" + route.connection + ":" + route.conversation
    : route.sender;
}

export function directBinding(route) {
  if (route.group || route.companion || route.sponsored || !route.directAccess)
    return null;
  const fields =
    route.channel === "slack"
      ? [route.channel, route.connection, route.conversation, route.sender]
      : [route.channel, route.conversation, route.sender];
  const key = fields.join(":");
  return directGrant.test(key) ? key : null;
}

// A signing-approved gateway receipt is not a file grant. Keep a separate
// transcript generation for each owner-selected binding and exact file list.
export function openProjectGrants(db, config) {
  validateProjectConfig(config);
  const revisions = new Map();
  db.exec(
    "CREATE TABLE IF NOT EXISTS project_grants (scope TEXT PRIMARY KEY, revision TEXT NOT NULL)",
  );
  const scope = (key) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          key,
          config.projectDirectory,
          [...(config.projectFiles ?? [])].sort(),
          ...(!key.startsWith("a2a:") &&
          (config.projectReadWorkspace || config.projectTestCommand?.length)
            ? [
                Boolean(config.projectReadWorkspace),
                config.projectTestCommand ?? [],
              ]
            : []),
        ]),
      )
      .digest("hex");
  if (
    config.projectFiles?.length ||
    config.projectReadWorkspace ||
    config.projectTestCommand?.length
  ) {
    const keys = [
      ...(config.projectFiles?.length
        ? (config.trustedAgentIds ?? [])
        : []
      ).map((id) => "a2a:" + id),
      ...(config.trustedConversations ?? []).filter((key) =>
        directGrant.test(key),
      ),
    ];
    for (const key of keys) {
      const hash = scope(key);
      db.prepare("INSERT OR IGNORE INTO project_grants VALUES(?,?)").run(
        hash,
        randomUUID(),
      );
      revisions.set(
        hash,
        db
          .prepare("SELECT revision FROM project_grants WHERE scope=?")
          .get(hash).revision,
      );
    }
  }
  // On restart, invalidate revoked grants, including jobs with an unsent answer.
  for (const { scope: hash } of db
    .prepare("SELECT scope FROM project_grants")
    .all()) {
    if (!revisions.has(hash))
      db.prepare("DELETE FROM project_grants WHERE scope=?").run(hash);
  }
  return (route) => {
    const key =
      route.channel === "a2a" &&
      config.trustedAgentIds?.includes(route.callerId)
        ? "a2a:" + route.callerId
        : directBinding(route);
    if (
      !key ||
      (route.channel !== "a2a" && !config.trustedConversations?.includes(key))
    )
      return null;
    return revisions.get(scope(key)) ?? null;
  };
}

// Quoting a previously top-level message can assign the parent its own ID
// as its thread root. It is still the same source, not a different thread.
export function phoneSubthread(message, root, parent) {
  return !parent && root === message ? "" : root || "";
}

export function samePhoneThread(route, source) {
  const root = source.threadRootMessageId || source.threadId || "";
  return (
    root === (route.subthread || "") ||
    phoneSubthread(source.id, root, source.replyToMessageId) ===
      (route.subthread || "")
  );
}

// Inkbox's identity-scoped resource reads are authoritative for both halves of
// the binding. Never run a project turn using a webhook's copy of the prompt.
export async function verifyProjectConversation(route, identity, client) {
  if (
    !directBinding(route) ||
    (route.allowedRecipients?.length &&
      !route.allowedRecipients.some(
        (v) => v.trim().toLowerCase() === projectAudience(route).toLowerCase(),
      ))
  )
    return false;
  if (route.channel === "sms") return verifyText(route, identity);
  if (route.channel === "email") return verifyMail(route, identity);
  if (route.channel === "slack") return verifySlack(route, identity, client);
  const whatsapp = route.channel === "whatsapp";
  const source = whatsapp
    ? await identity.getWhatsAppMessage(route.message)
    : await identity.getIMessage(route.message);
  const destination = whatsapp
    ? await identity.getWhatsAppConversation(route.conversation)
    : await identity.getIMessageConversation(route.conversation);
  const ownedNumber = whatsapp
    ? identity.whatsappNumber
    : identity.imessageNumber?.number;
  if (
    !source ||
    !destination ||
    source.id !== route.message ||
    source.conversationId !== route.conversation ||
    destination.id !== route.conversation ||
    source.direction !== "inbound" ||
    source.isBlocked !== false ||
    source.remoteNumber !== route.sender ||
    destination.remoteNumber !== route.sender ||
    (source.senderNumber != null && source.senderNumber !== route.sender) ||
    source.isGroup !== false ||
    destination.isGroup !== false ||
    !samePhoneThread(route, source) ||
    typeof source.content !== "string" ||
    !source.content.trim()
  )
    return false;
  for (const snapshot of [source.participants, destination.participants]) {
    if (
      snapshot != null &&
      (!Array.isArray(snapshot) ||
        snapshot.some((p) => p !== route.sender && p !== ownedNumber))
    )
      return false;
  }
  if (whatsapp) {
    if (
      !ownedNumber ||
      source.agentIdentityId !== identity.id ||
      destination.agentIdentityId !== identity.id ||
      source.localNumber !== ownedNumber ||
      destination.localNumber !== ownedNumber ||
      source.unresolvedParticipantCount !== 0 ||
      destination.unresolvedParticipantCount !== 0 ||
      source.senderAccess !== "direct" ||
      (destination.activeConversationId != null &&
        destination.activeConversationId !== route.conversation)
    )
      return false;
  } else if (
    source.service !== "imessage" ||
    source.wasDowngraded === true ||
    source.assignmentId !== route.assignment ||
    source.assignmentId !== destination.assignmentId ||
    (destination.assignmentId
      ? destination.assignmentStatus !== "active"
      : !ownedNumber)
  )
    return false;
  route.text = source.content;
  return true;
}

async function verifyText(route, identity) {
  if (!identity.phoneNumber?.number) return false;
  const source = await identity.getText(route.message);
  if (
    source?.id !== route.message ||
    source.localPhoneNumber !== identity.phoneNumber.number ||
    source.conversationId !== route.conversation ||
    source.direction !== "inbound" ||
    source.isBlocked !== false ||
    source.origin !== "user_initiated" ||
    source.remotePhoneNumber !== route.sender ||
    (source.senderPhoneNumber != null &&
      source.senderPhoneNumber !== route.sender) ||
    typeof source.text !== "string" ||
    !source.text.trim()
  )
    return false;
  const dest = await findTextConversation(route, identity);
  if (
    dest?.isGroup !== false ||
    dest.remotePhoneNumber !== route.sender ||
    !Array.isArray(dest.participants) ||
    dest.participants.length !== 1 ||
    dest.participants[0] !== route.sender
  )
    return false;
  route.text = source.text;
  route.noControls ||= Boolean(source.media?.length);
  return true;
}

const address = (value) =>
  typeof value === "string" ? value.toLowerCase() : "";
const oneAddress = (list, expected) =>
  Array.isArray(list) && list.length === 1 && address(list[0]) === expected;
const empty = (list) =>
  list === null || (Array.isArray(list) && list.length === 0);

// Commands must begin in the author's own text. Discard a conventional mail
// quote/footer only after that text, never search quoted history for a command.
export function mailControl(body) {
  if (typeof body !== "string") return "";
  const lines = body.trimStart().replace(/\r\n/g, "\n").split("\n");
  if (
    !/^\/(?:approve|deny|verify|answer|stop|cancel|clear|new|status)(?:\s|$)/i.test(
      lines[0],
    )
  )
    return body.trim();
  // Check the trailing quoted block once. SDK mail bodies can be much larger
  // than their webhook previews, including thousands of quoted lines.
  const lastUnquoted = lines.findLastIndex(
    (s) => s.trim() && !s.startsWith(">"),
  );
  const hasTrailingQuote =
    lines.findLastIndex((s) => s.startsWith(">")) > lastUnquoted;
  const tail = lines.findIndex(
    (line, i) =>
      i > 0 &&
      (line === "-- " ||
        (i > lastUnquoted && line.startsWith(">")) ||
        (i === lastUnquoted &&
          hasTrailingQuote &&
          /^On .+ wrote:$/i.test(line)) ||
        (line === "-----Original Message-----" &&
          /^From:\s+/i.test(lines[i + 1] ?? ""))),
  );
  return (tail === -1 ? lines : lines.slice(0, tail)).join("\n").trim();
}

async function verifyMail(route, identity) {
  const own = address(identity.mailbox?.emailAddress);
  if (!own || own === route.sender) return false;
  const source = await identity.getMessage(route.message);
  const directEnvelope = (message) => {
    const inbound = message.direction === "inbound";
    return (
      (inbound || message.direction === "outbound") &&
      message.mailboxId === identity.mailbox.id &&
      message.threadId === route.conversation &&
      address(message.fromAddress) === (inbound ? route.sender : own) &&
      oneAddress(message.toAddresses, inbound ? own : route.sender) &&
      empty(message.ccAddresses)
    );
  };
  if (
    !source ||
    source.id !== route.message ||
    source.direction !== "inbound" ||
    source.status !== "received" ||
    source.importJobId != null ||
    !directEnvelope(source) ||
    !empty(source.bccAddresses) ||
    !oneAddress(source.replyAllRecipients?.to, route.sender) ||
    !empty(source.replyAllRecipients?.cc) ||
    typeof source.messageId !== "string" ||
    !source.messageId ||
    /[\r\n\0]/.test(source.messageId)
  )
    return false;
  const body = source.bodyText?.trim() || authoredHtmlText(source.bodyHtml);
  if (!body) return false;
  const thread = await identity.getThread(route.conversation);
  if (
    thread?.id !== route.conversation ||
    thread.mailboxId !== identity.mailbox.id ||
    !["inbox", "archive"].includes(thread.folder) ||
    !Array.isArray(thread.messages) ||
    thread.messageCount !== thread.messages.length ||
    !thread.messages.every(directEnvelope) ||
    !thread.messages.some((m) => m.id === route.message)
  )
    return false;
  route.text = [source.subject, body].filter(Boolean).join("\n");
  route.control = mailControl(body);
  route.mailParent = source.messageId;
  route.mailSubject = (source.subject ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 240);
  route.noControls ||= Boolean(source.hasAttachments);
  return true;
}

async function slackInstallation(route, identity, client) {
  const { connections } = await client.slack.listConnections(identity.id);
  const matches = connections.filter(
    (c) =>
      c.id === route.connection &&
      c.identityId === identity.id &&
      c.workspaceId === route.workspace &&
      c.status === "connected" &&
      Number.isSafeInteger(c.generation) &&
      c.generation > 0 &&
      (route.generation == null || c.generation === route.generation),
  );
  return matches.length === 1 &&
    matches[0].botUserId &&
    matches[0].botUserId !== route.actor
    ? matches[0]
    : null;
}

async function verifySlack(route, identity, client) {
  const initial = await slackInstallation(route, identity, client);
  if (!initial) return false;
  route.generation = initial.generation;
  const profile = await client.slack.getUser(route.connection, route.actor);
  if (
    profile?.id !== route.actor ||
    profile.is_bot !== false ||
    profile.deleted === true ||
    profile.is_app_user === true ||
    !profile.team_id ||
    profile.team_id + ":" + route.actor !== route.sender
  )
    return false;
  if (
    route.allowedSenders?.length &&
    !route.allowedSenders.some(
      (peer) => peer.toLowerCase() === route.sender.toLowerCase(),
    )
  )
    return false;
  const destination = await client.slack.getConversation(
    route.connection,
    route.conversation,
  );
  if (
    destination?.id !== route.conversation ||
    destination.is_im !== true ||
    destination.is_mpim === true ||
    destination.is_archived === true ||
    destination.user !== route.actor
  )
    return false;
  const source = await archivedSlackSource(route, client);
  if (
    !source ||
    source.senderAccess !== "direct" ||
    source.botId ||
    source.subtype ||
    typeof source.text !== "string" ||
    !source.text.trim()
  )
    return false;
  // Each SDK read checks its own generation. Fence the sequence as a whole:
  // profile, live DM and archive must all belong to the same installation.
  const current = await slackInstallation(route, identity, client);
  if (!current || current.botUserId !== initial.botUserId) return false;
  route.archivedMessage = source.id;
  route.text = source.text;
  route.control = source.text.trim();
  route.noControls ||= Boolean(source.files?.length);
  return true;
}
