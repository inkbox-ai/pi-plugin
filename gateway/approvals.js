import { randomBytes } from "node:crypto";
import { encodeEditProposal } from "./pi-rpc.js";

// Reserve the control words even if the nonce is missing, invalid or stale.
// Such messages are never instructions for the model.
export const isEditControl = (text) => /^\/(approve|deny)(?:\s|$)/i.test(text);

// A copied gateway token should not become a model prompt on a different
// channel. Ordinary prose beginning with "/approve" isn't a gateway control.
export function reservedEditControl(route, text) {
  return (
    isEditControl(text) &&
    ((route.projectGrant && ["imessage", "whatsapp"].includes(route.channel)) ||
      /^\/(?:approve|deny)\s+[a-f0-9]{24}$/i.test(text))
  );
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
        (command === pending.approve || command === pending.deny),
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
      else pending.decision.resolve(route);
      return true;
    },
    async request({
      route,
      proposal,
      signal,
      send,
      verify,
      remainingMs = DECISION_WINDOW_MS,
    }) {
      if (pending || signal.aborted) return false;
      let encoded;
      try {
        encoded = encodeEditProposal(proposal);
      } catch {
        return false;
      }
      const code = randomBytes(12).toString("hex");
      const approve = "/approve " + code;
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
      const prompt =
        "Pi requests one exact file edit (JSON):\n" +
        encoded +
        `\nReply within ${seconds} seconds:\n` +
        approve +
        "\nor\n" +
        deny;
      void (async () => {
        if (!(await verify(route)) || !live()) return false;
        const sent = await send(prompt, code);
        if (sent?.skipped || !live()) return false;
        request.promptId = sent?.id;
        const response = await decision.promise;
        if (!response || !live()) return false;
        // Both the request and the decision must still refer to their original
        // Inkbox sources and audience when the result is released to Pi.
        return (
          (await verify(route)) &&
          live() &&
          (await verify(response, approve)) &&
          live()
        );
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
