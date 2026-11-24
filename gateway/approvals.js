import { randomBytes } from "node:crypto";
import { encodeEditProposal, encodeProjectAction } from "./pi-rpc.js";

// Reserve the control words even if the nonce is missing, invalid or stale.
// Such messages are never instructions for the model.
export const isEditControl = (text) =>
  /^\/(approve|deny|answer|verify)(?:\s|$)/i.test(text);

// A copied gateway token should not become a model prompt on a different
// channel. Ordinary prose beginning with "/approve" isn't a gateway control.
export function reservedEditControl(route, text) {
  return (
    isEditControl(text) &&
    ((route.projectGrant && route.channel !== "a2a") ||
      /^\/(?:approve|deny|answer|verify)\s+[a-f0-9]{24}(?:\s|$)/i.test(text))
  );
}

export function normalizedCommand(text) {
  const raw = text.trim();
  const answer = /^\/answer\s+([a-f0-9]{24})\s+([\s\S]+)$/i.exec(raw);
  if (answer)
    return "/answer " + answer[1].toLowerCase() + " " + answer[2].trim();
  return raw.toLowerCase();
}

// A signed email webhook projects HTML into a flat string and can append a
// quoted previous email. Use the leading nonce only to schedule the decision.
// Its verb, code and answer are checked against the SDK message before use.
export function admissionDecision(route, text) {
  if (route.channel !== "email") return text;
  const match = /^(\/(verify|approve|deny|answer) [a-f0-9]{24})(?:\s|$)/.exec(
    text,
  );
  if (!match) return text;
  return match[2] === "answer" ? match[1] + " ?" : match[1];
}

// Project turns are serialized. The sole pending decision belongs to one live
// turn, never the persistent session. A restart cannot reissue or consume it.
const DECISION_WINDOW_MS = 120_000;

export function createEditApprovals() {
  let pending;

  function controlThread(route) {
    if (
      !pending?.live() ||
      !route.projectGrant ||
      route.projectGrant !== pending.route.projectGrant ||
      route.channel !== pending.route.channel ||
      route.conversation !== pending.route.conversation ||
      route.assignment !== pending.route.assignment ||
      route.connection !== pending.route.connection ||
      route.workspace !== pending.route.workspace ||
      (route.generation != null &&
        route.generation !== pending.route.generation) ||
      route.sender !== pending.route.sender
    )
      return;
    // Native Reply can make the original message or the prompt the thread root.
    if (
      route.thread === pending.route.thread ||
      (route.subthread &&
        (route.subthread === pending.route.message ||
          route.subthread === pending.promptId))
    )
      return pending.route.thread;
  }

  function matches(route, command) {
    return Boolean(
      controlThread(route) &&
        !pending.consumed &&
        (command === pending.deny ||
          (pending.question
            ? command.startsWith(pending.approve + " ") &&
              command.length > pending.approve.length + 1 &&
              command.length <= pending.approve.length + 1 + 2000
            : command === pending.approve)),
    );
  }

  return {
    matches,
    controlThread,
    failedPrompt(channel, message) {
      if (pending?.route.channel === channel && pending.promptId === message)
        pending.rejectEdit();
    },
    consume(route, command) {
      if (!matches(route, command)) return false;
      pending.consumed = true;
      if (command === pending.deny) pending.rejectEdit();
      else pending.decision.resolve({ route, command });
      return true;
    },
    async request({
      route,
      proposal,
      mailboxProof = false,
      signal,
      send,
      verify,
      remainingMs = DECISION_WINDOW_MS,
    }) {
      if (pending || signal.aborted) return false;
      let encoded;
      try {
        encoded = mailboxProof
          ? ""
          : proposal?.kind
            ? encodeProjectAction(proposal)
            : encodeEditProposal(proposal);
      } catch {
        return false;
      }
      const code = randomBytes(12).toString("hex");
      const question = proposal?.kind === "question";
      const approve =
        (mailboxProof ? "/verify " : question ? "/answer " : "/approve ") +
        code;
      const deny = "/deny " + code;
      const decision = Promise.withResolvers();
      const result = Promise.withResolvers();
      const seconds = Math.floor(
        Math.min(DECISION_WINDOW_MS, remainingMs) / 1000,
      );
      if (!Number.isFinite(seconds) || seconds < 1) return false;
      const windowMs = seconds * 1000;
      const deadline = performance.now() + windowMs;
      const lifetime = AbortSignal.any([signal, AbortSignal.timeout(windowMs)]);
      const live = () => !lifetime.aborted && performance.now() < deadline;
      const request = {
        route,
        approve,
        deny,
        question,
        decision,
        live,
        consumed: false,
        rejectEdit: () => result.resolve(false),
      };
      pending = request;
      const abort = () => {
        decision.resolve(null);
        result.resolve(false);
      };
      lifetime.addEventListener("abort", abort, { once: true });
      // An inbound command can arrive before the outgoing SDK call resolves.
      // Require both: a failed/ambiguous send must never authorize an edit.
      const heading = mailboxProof
        ? "Did you send the preceding project request or command in this email thread? Verify only if you did."
        : question
          ? "Pi has a question (JSON):"
          : proposal.kind === "test"
            ? "Run this configured project test (JSON)?"
            : proposal.kind === "email"
              ? "Send this exact email (JSON)?"
              : "Pi requests one exact file edit (JSON):";
      const prompt =
        heading +
        (encoded ? "\n" + encoded : "") +
        `\nReply within ${seconds} seconds:\n` +
        approve +
        (question ? " YOUR ANSWER" : "") +
        "\nor\n" +
        deny;
      void (async () => {
        if (!(await verify(route)) || !live()) return false;
        const sent = await send(prompt, code);
        if (sent?.skipped || !live()) return false;
        request.promptId = sent?.messageTs ?? sent?.id;
        const response = await decision.promise;
        if (!response || !live()) return false;
        // Both the request and the decision must still refer to their original
        // Inkbox sources and audience when the result is released to Pi.
        if (
          !(await verify(route)) ||
          !live() ||
          !(await verify(response.route, response.command)) ||
          !live()
        )
          return false;
        return question ? response.command.slice(approve.length + 1) : true;
      })().then(result.resolve, () => result.resolve(false));
      try {
        return await result.promise;
      } finally {
        decision.resolve(null);
        lifetime.removeEventListener("abort", abort);
        pending = undefined;
      }
    },
  };
}
