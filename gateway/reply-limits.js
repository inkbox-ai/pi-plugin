// Keep a gateway reply a single idempotent message. Mark truncation explicitly;
// the complete answer remains in Pi's conversation history.
import { slackMrkdwn } from "../extension/slack-style.js";

const limits = { sms: 1600, imessage: 18995, whatsapp: 4000, slack: 12000 };
const suffix = "\n[Reply shortened to fit this channel.]";

export function boundedReply(channel, text, { verbatim = false } = {}) {
  const limit = limits[channel];
  if (!limit) return text;
  const clean = (
    channel === "slack" && !verbatim ? slackMrkdwn(text) : text
  ).replaceAll("\0", "");
  if (clean.length <= limit) return clean;
  let end = limit - suffix.length;
  if (/[\uD800-\uDBFF]/.test(clean[end - 1])) end--;
  return clean.slice(0, end).trimEnd() + suffix;
}
