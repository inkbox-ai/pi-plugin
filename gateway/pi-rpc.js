export const PERMISSION_TITLE = "Inkbox permission";
const SUMMARY_LIMIT = 1200;

// Shown to a person in a chat: keep line breaks, drop control and
// direction-override characters that could rearrange the surrounding text.
const printable = (text) =>
  text
    .replace(
      /[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
      " ",
    )
    .trim();

export function permissionRequest(key, summary) {
  return JSON.stringify({ key, summary });
}

/**
 * Drives one Pi turn over RPC. The only dialog forwarded out of the process is
 * this package's own permission question; any other dialog is cancelled.
 */
export function createTurnRpc(stdin, signal, askPermission) {
  const promptId = "inkbox-turn";
  let accepted = false;
  let settled = false;

  function send(record) {
    if (!signal.aborted && stdin.writable && !stdin.writableEnded)
      stdin.write(JSON.stringify(record) + "\n");
  }
  async function handleDialog(event) {
    const response = { type: "extension_ui_response", id: event.id };
    if (
      event.method !== "input" ||
      event.title !== PERMISSION_TITLE ||
      !askPermission
    )
      return send({ ...response, cancelled: true });
    try {
      const request = JSON.parse(event.placeholder);
      const summary =
        typeof request?.summary === "string" ? printable(request.summary) : "";
      if (typeof request?.key !== "string" || !request.key || !summary)
        throw new Error("Invalid permission request.");
      // Say so when the person cannot see everything they would approve.
      const hidden = summary.length - SUMMARY_LIMIT;
      const answer = await askPermission(
        {
          key: request.key.slice(0, 500),
          summary:
            hidden > 0
              ? summary.slice(0, SUMMARY_LIMIT) +
                "… [" +
                hidden +
                " more characters not shown]"
              : summary,
        },
        signal,
      );
      send({
        ...response,
        value:
          answer === "once" || answer === "always"
            ? "allow"
            : answer === "timeout"
              ? "timeout"
              : "deny",
      });
    } catch {
      send({ ...response, cancelled: true });
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
          throw Object.assign(
            new Error("Pi did not start the requested turn."),
            {
              piError: typeof event.error === "string" ? event.error : "",
            },
          );
        accepted = true;
      } else if (event.type === "agent_settled") {
        settled = true;
      }
      if (accepted && settled && !stdin.writableEnded) stdin.end();
    },
    started() {
      return accepted;
    },
    completed() {
      return accepted && settled;
    },
  };
}
