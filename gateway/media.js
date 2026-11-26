// Retain descriptions and source-bound speech results only. Attachment URLs
// are not passed to the model or fetched from webhook input.
const text = (value, max) =>
  typeof value === "string" ? value.slice(0, max) : "";
const channels = new Set(["sms", "imessage", "whatsapp", "slack"]);
const terminal = new Set(["completed", "skipped", "failed"]);

export function attachments(items) {
  if (!Array.isArray(items)) return [];
  let remaining = 32768;
  return items.slice(0, 16).map((raw) => {
    const t = raw?.transcription;
    const item = {
      id: text(raw?.id, 256),
      name: text(raw?.filename ?? raw?.name, 200),
      mime: text(raw?.content_type ?? raw?.contentType ?? raw?.mimetype, 100),
      size: Number.isSafeInteger(raw?.size) && raw.size >= 0 ? raw.size : null,
    };
    if (
      t &&
      (terminal.has(t.status) || t.status === "pending") &&
      (t.error_code ?? t.errorCode) !== "not_audio"
    ) {
      item.status = t.status;
      if (t.status === "completed" && typeof t.text === "string") {
        item.text = text(t.text, remaining);
        remaining -= item.text.length;
        item.truncated = t.text.length > item.text.length;
      }
    }
    return item;
  });
}

export function describeMedia(items) {
  if (!items?.length) return "";
  return items
    .map((item, index) => {
      const label = [
        item.name,
        item.mime,
        item.size != null ? item.size + " bytes" : "",
      ]
        .filter(Boolean)
        .join(", ");
      const lines = [
        "Attachment " +
          (index + 1) +
          (label ? " (" + label + ")" : "") +
          ": binary content not opened.",
      ];
      if (item.status === "completed")
        lines.push(
          "Automatic voice-note transcript: " +
            (item.text?.trim() || "(no speech)") +
            (item.truncated ? " [truncated]" : ""),
        );
      else if (item.status) lines.push("Voice-note transcript unavailable.");
      return lines.join("\n");
    })
    .join("\n");
}

export function refreshMedia(route, rawItems) {
  if (!route.media?.some((item) => item.status === "pending")) return;
  const current = attachments(rawItems);
  route.media = route.media.map((old, index) => {
    if (old.status !== "pending") return old;
    // Legacy media without IDs: the caller checked the exact source message;
    // accept positional results only for an otherwise identical attachment.
    const found = old.id
      ? current.find((item) => item.id === old.id)
      : current[index];
    if (
      !found ||
      !terminal.has(found.status) ||
      (!old.id &&
        (current.length !== route.media.length ||
          found.id ||
          found.mime !== old.mime ||
          found.name !== old.name ||
          found.size !== old.size))
    )
      return old;
    return {
      ...old,
      status: found.status,
      text: found.text,
      truncated: found.truncated,
    };
  });
}

export const waitsForTranscript = (route) =>
  route.media?.some((item) => item.status === "pending");
export function transcriptSource(route) {
  if (!channels.has(route.channel) || !route.media?.length) return null;
  const key = route.channel === "slack" ? route.archivedMessage : route.message;
  return key ? JSON.stringify([route.channel, key]) : null;
}

// This notification is only a hint to poll an already-admitted message. Its
// contents are never used as a turn, route, or transcript.
export function completionSource(event) {
  if (event.event_type !== "message.transcription_finished") return null;
  const data = event.data,
    channel = data?.channel === "text" ? "sms" : data?.channel;
  if (
    !channels.has(channel) ||
    typeof data?.message_id !== "string" ||
    !data.message_id
  )
    return null;
  const message = channel === "sms" ? data.text_message : data.message;
  if (
    channel !== "slack" &&
    (message?.id !== data.message_id || message.direction !== "inbound")
  )
    return null;
  return JSON.stringify([channel, data.message_id]);
}
