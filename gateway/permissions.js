// Approval questions are relayed to the person in the conversation, who
// answers with a short reply. A choice of "always" lasts for the session.

const ONCE = new Set([
  "1",
  "y",
  "yes",
  "yes please go ahead",
  "ok",
  "okay",
  "approve",
  "allow",
  "sure",
  "go",
  "go ahead",
]);
const ALWAYS = new Set([
  "2",
  "always",
  "allow always",
  "always allow",
  "yes always",
]);
const REJECT = new Set([
  "3",
  "n",
  "no",
  "deny",
  "decline",
  "stop",
  "block",
  "don't",
  "dont",
  "reject",
  "cancel",
]);

export const DEFAULT_PERMISSION_TIMEOUT_S = 600;

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Drop a leading mention of this agent, as a group answer is addressed to it. */
export function withoutMention(text, handle) {
  const names = ["agent", ...(handle ? [escaped(handle)] : [])].join("|");
  return text.replace(
    new RegExp(
      "^(?:\\s*(?:<@[^>\\s]+>|@(?:" + names + ")(?![\\w.-]))[\\s,:]*)+",
      "i",
    ),
    "",
  );
}

/** @returns {"once" | "always" | "reject" | null} null when the text is not an answer. */
export function parsePermissionReply(text) {
  if (typeof text !== "string" || text.length > 64) return null;
  const answer = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ");
  if (ALWAYS.has(answer)) return "always";
  if (ONCE.has(answer)) return "once";
  if (REJECT.has(answer)) return "reject";
  return null;
}

export function permissionPrompt(summary, { mention = false } = {}) {
  return (
    "Permission needed: " +
    summary +
    "\n\nReply 1 to allow once, 2 to always allow (this conversation), or 3 to decline." +
    (mention
      ? " Include @agent in your answer (for example, @agent allow)."
      : "")
  );
}

/**
 * Open questions are keyed by the conversation they were asked in and the
 * address that was asked. An "always" answer belongs to that person's session.
 */
export function createPermissions() {
  const pending = new Map();
  const always = new Map();
  const queues = new Map();
  const remembered = (session, actor) => always.get(session)?.get(actor);

  async function ask(request) {
    const { conversation, session, actor, key, signal } = request;
    if (signal.aborted) return "reject";
    if (remembered(session, actor)?.has(key)) return "once";
    const decision = Promise.withResolvers();
    const open = { actor, delivered: false, resolve: decision.resolve };
    const timer = setTimeout(
      () => decision.resolve("timeout"),
      request.timeoutMs,
    );
    const abort = () => decision.resolve("reject");
    signal.addEventListener("abort", abort, { once: true });
    pending.set(conversation, open);
    try {
      // Only a reply to a question the person can already see is an answer.
      const sent = Promise.resolve()
        .then(() =>
          request.send(
            permissionPrompt(request.summary, { mention: request.mention }),
          ),
        )
        .then((result) => {
          if (result?.skipped) decision.resolve("reject");
          else open.delivered = true;
        })
        .catch(() => decision.resolve("reject"));
      const answer = await decision.promise;
      await sent;
      if (answer === "always") {
        if (!always.has(session)) always.set(session, new Map());
        const people = always.get(session);
        if (!people.has(actor)) people.set(actor, new Set());
        people.get(actor).add(key);
      }
      return answer;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (pending.get(conversation) === open) pending.delete(conversation);
    }
  }

  return {
    /**
     * Ask the person in this conversation. Questions for one conversation are
     * asked one at a time.
     * @returns {Promise<"once" | "always" | "reject" | "timeout">}
     */
    ask(request) {
      const previous = queues.get(request.conversation) ?? Promise.resolve();
      const next = previous.then(() => ask(request));
      const settled = next.catch(() => {});
      queues.set(request.conversation, settled);
      void settled.then(() => {
        if (queues.get(request.conversation) === settled)
          queues.delete(request.conversation);
      });
      return next;
    },
    /**
     * Offer an incoming message to the open question for its conversation.
     * @returns {"answered" | "declined" | null} "declined" means the message is
     * not an answer; the question is closed and the message is ordinary work.
     */
    answer(conversation, actor, text) {
      const open = pending.get(conversation);
      if (!open || !open.delivered || open.actor !== actor) return null;
      const decision = parsePermissionReply(text);
      pending.delete(conversation);
      open.resolve(decision ?? "reject");
      return decision ? "answered" : "declined";
    },
    /** Forget "always" choices when the session is reset. */
    clear(session) {
      always.delete(session);
    },
  };
}
