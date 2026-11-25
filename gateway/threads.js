import { parsePermissionReply, withoutMention } from "./permissions.js";

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

// A command or approval answer must begin the author's own text. Discard a
// conventional mail quote or footer after it; never search quoted history.
export function mailControl(body) {
  if (typeof body !== "string") return "";
  const lines = body.trimStart().replace(/\r\n/g, "\n").split("\n");
  if (
    !/^\/(?:stop|cancel|clear|new|status)(?:\s|$)/i.test(lines[0]) &&
    !parsePermissionReply(withoutMention(lines[0]))
  )
    return body.trim();
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
