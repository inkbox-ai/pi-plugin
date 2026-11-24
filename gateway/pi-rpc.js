// Exact, single-line change shown to the owner. Bidi controls, newlines and
// invisible Unicode must not be able to rearrange the surrounding instructions.
const PROPOSAL_LIMIT = 1200;
export const PROJECT_EDIT_TITLE = "Inkbox project edit";

export function encodeEditProposal(proposal) {
  if (
    !proposal ||
    typeof proposal !== "object" ||
    Object.keys(proposal).length !== 3
  )
    throw new Error("Invalid edit proposal.");
  const { file, oldText, newText } = proposal;
  const fields = [file, oldText, newText];
  if (
    !file ||
    !oldText ||
    fields.some(
      (s) => typeof s !== "string" || !s.isWellFormed() || s.includes("\0"),
    )
  )
    throw new Error("Invalid edit proposal.");
  if (fields.some((s) => s.length > PROPOSAL_LIMIT))
    throw new Error("Change is too long to review in one message.");
  const encoded = JSON.stringify({ file, oldText, newText }).replace(
    /[^\x20-\x7e]|[*_~`<>]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  if (encoded.length > PROPOSAL_LIMIT)
    throw new Error("Change is too long to review in one message.");
  return encoded;
}

// Only this package's granted-file extension is loaded in this child. Do not
// translate arbitrary Pi dialogs (or model text) into requests on the channel.
export function createEditRpc(stdin, files, confirmEdit, signal) {
  const promptId = "inkbox-turn";
  let accepted = false;
  let settled = false;
  let pending = false;

  function send(record) {
    if (!signal.aborted && stdin.writable && !stdin.writableEnded)
      stdin.write(JSON.stringify(record) + "\n");
  }
  async function handleDialog(event) {
    const response = { type: "extension_ui_response", id: event.id };
    if (
      event.method !== "confirm" ||
      event.title !== PROJECT_EDIT_TITLE ||
      pending ||
      !confirmEdit
    ) {
      send({ ...response, cancelled: true });
      return;
    }
    pending = true;
    let confirmed = false;
    try {
      if (
        typeof event.message === "string" &&
        event.message.length <= PROPOSAL_LIMIT
      ) {
        const proposal = JSON.parse(event.message);
        if (
          event.message === encodeEditProposal(proposal) &&
          files.includes(proposal.file)
        )
          confirmed = (await confirmEdit(proposal, signal)) === true;
      }
    } catch {
      // Invalid proposals, delivery failures, and expired decisions never approve.
    } finally {
      pending = false;
    }
    send({ ...response, confirmed });
  }
  return {
    start(message) {
      send({ id: promptId, type: "prompt", message });
    },
    handle(event) {
      if (
        event.type === "extension_ui_request" &&
        typeof event.id === "string" &&
        !signal.aborted
      ) {
        if (["confirm", "input", "select", "editor"].includes(event.method))
          void handleDialog(event);
      } else if (
        event.type === "response" &&
        event.id === promptId &&
        event.command === "prompt"
      ) {
        if (!event.success || event.data?.disposition !== "started")
          throw new Error("Pi did not start the requested turn.");
        accepted = true;
      } else if (event.type === "agent_settled") {
        settled = true;
      }
      if (accepted && settled && !stdin.writableEnded) stdin.end();
    },
    completed() {
      return accepted && settled;
    },
  };
}
