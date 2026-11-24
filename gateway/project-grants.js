import { createHash, randomUUID } from "node:crypto";

const directGrant = /^(imessage|whatsapp):[^:\s]+:\+[1-9]\d{6,14}$/;

export function directBinding(route) {
  if (route.group || route.companion || route.sponsored || !route.directAccess)
    return null;
  const key = [route.channel, route.conversation, route.sender].join(":");
  return directGrant.test(key) ? key : null;
}

// A signing-approved gateway receipt is not a file grant. Keep a separate
// transcript generation for each owner-selected binding and exact file list.
export function openProjectGrants(db, config) {
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
        ]),
      )
      .digest("hex");
  if (config.projectFiles?.length) {
    const keys = [
      ...(config.trustedAgentIds ?? []).map((id) => "a2a:" + id),
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
export async function verifyProjectConversation(route, identity) {
  if (!directBinding(route)) return false;
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
  if (
    route.allowedRecipients?.length &&
    !route.allowedRecipients.includes(route.sender)
  )
    return false;
  route.text = source.content;
  return true;
}
