import { randomBytes } from "node:crypto";
import { encodeEditProposal } from "./pi-rpc.js";

// Reserve the control words even if the nonce is missing, invalid or stale.
// Such messages are never instructions for the model.
export const isEditControl = (text) => /^\/(approve|deny)(?:\s|$)/i.test(text);

// Project turns are serialized. The sole pending decision belongs to one live
// turn, never the persistent session. A restart cannot reissue or consume it.
const DECISION_WINDOW_MS = 120_000;

export function createEditApprovals() {
  let pending;

  function matches(route, command) {
    return Boolean(
      pending &&
        pending.live() &&
        !pending.consumed &&
        route.projectGrant === pending.route.projectGrant &&
        route.channel === pending.route.channel &&
        route.conversation === pending.route.conversation &&
        route.assignment === pending.route.assignment &&
        (route.thread === pending.route.thread ||
          // A phone's native Reply action can create a subthread when the
          // original message was top-level. Only these two roots belong to it.
          (route.subthread &&
            (route.subthread === pending.route.message ||
              route.subthread === pending.promptId))) &&
        route.sender === pending.route.sender &&
        (command === pending.approve || command === pending.deny),
    );
  }

  return {
    matches,
    consume(route, command) {
      if (!matches(route, command)) return false;
      pending.consumed = true;
      if (command === pending.deny) pending.rejectEdit();
      else pending.decision.resolve(route);
      return true;
    },
    async request({ route, proposal, signal, send, verify }) {
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
      const deadline = performance.now() + DECISION_WINDOW_MS;
      const lifetime = AbortSignal.any([
        signal,
        AbortSignal.timeout(DECISION_WINDOW_MS),
      ]);
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
        "\nReply within 2 minutes:\n" +
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
