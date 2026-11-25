// Exact, single-line change shown to the owner. Bidi controls, newlines and
// invisible Unicode must not be able to rearrange the surrounding instructions.
const PROPOSAL_LIMIT = 1200;
export const IDENTITY_LOOKUP_TITLE = "Inkbox identity lookup";
export const PROJECT_ACTION_TITLE = "Inkbox project action";
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
  return encode({ file, oldText, newText });
}

function encode(value) {
  const encoded = JSON.stringify(value).replace(
    /[^\x20-\x7e]|[*_~`<>]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  if (encoded.length > PROPOSAL_LIMIT)
    throw new Error("Change is too long to review in one message.");
  return encoded;
}

export function encodeProjectAction(request) {
  const kind = request?.kind;
  const fields = {
    test: ["command"],
    question: ["question"],
    email: ["recipient", "subject", "body"],
  }[kind];
  if (
    !Array.isArray(fields) ||
    Object.keys(request).length !== fields.length + 1
  )
    throw new Error("Invalid project action.");
  const value = { kind };
  for (const key of fields) {
    const items = key === "command" ? request[key] : [request[key]];
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.length > 64 ||
      items.some(
        (s) =>
          typeof s !== "string" ||
          !s.isWellFormed() ||
          s.length > PROPOSAL_LIMIT ||
          s.includes("\0"),
      )
    )
      throw new Error("Invalid project action.");
    value[key] = request[key];
  }
  if (
    (kind === "test" && !value.command[0].trim()) ||
    (kind === "question" && !value.question.trim()) ||
    (kind === "email" &&
      (!value.body.trim() ||
        !value.subject.trim() ||
        /[\r\n]/.test(value.subject) ||
        !/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(value.recipient)))
  )
    throw new Error("Invalid project action.");
  return encode(value);
}

// Only this package's granted-file extension is loaded in this child. Do not
// translate arbitrary Pi dialogs (or model text) into requests on the channel.
export function createEditRpc(
  stdin,
  files,
  confirmEdit,
  signal,
  projectAction,
  command,
  lookupIdentity,
) {
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
    const edit =
      event.method === "confirm" &&
      event.title === PROJECT_EDIT_TITLE &&
      confirmEdit;
    const action =
      event.method === "input" &&
      event.title === PROJECT_ACTION_TITLE &&
      projectAction;
    const lookup =
      event.method === "input" &&
      event.title === IDENTITY_LOOKUP_TITLE &&
      lookupIdentity;
    if (pending || (!edit && !action && !lookup))
      return send({ ...response, cancelled: true });
    pending = true;
    try {
      if (lookup)
        return send({
          ...response,
          value: JSON.stringify(await lookupIdentity()),
        });
      const encoded = edit ? event.message : event.placeholder;
      if (typeof encoded !== "string" || encoded.length > PROPOSAL_LIMIT)
        throw new Error("Invalid proposal.");
      const proposal = JSON.parse(encoded);
      if (edit) {
        if (
          encoded !== encodeEditProposal(proposal) ||
          !files.includes(proposal.file)
        )
          throw new Error("Invalid edit.");
        send({
          ...response,
          confirmed: (await confirmEdit(proposal, signal)) === true,
        });
      } else {
        if (
          encoded !== encodeProjectAction(proposal) ||
          (proposal.kind === "test" &&
            JSON.stringify(proposal.command) !== JSON.stringify(command))
        )
          throw new Error("Invalid project action.");
        const value = await projectAction(proposal, signal);
        if (typeof value !== "string" || !value || value.length > 12_000)
          throw new Error("No result.");
        send({ ...response, value });
      }
    } catch {
      send({ ...response, cancelled: true });
    } finally {
      pending = false;
    }
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
