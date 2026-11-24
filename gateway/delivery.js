const NOTIFICATIONS = {
  "message.failed": ["email", "failed"],
  "message.bounced": ["email", "failed"],
  "text.delivery_failed": ["sms", "failed"],
  "text.delivery_unconfirmed": ["sms", "uncertain"],
  "imessage.delivery_failed": ["imessage", "failed"],
  "whatsapp.delivery_failed": ["whatsapp", "failed"],
  "whatsapp.delivery_unconfirmed": ["whatsapp", "uncertain"],
};

export function deliveryNotification(event, identity) {
  if (!event || typeof identity?.id !== "string" || !identity.id) return;
  const match =
    Object.hasOwn(NOTIFICATIONS, event.event_type) &&
    NOTIFICATIONS[event.event_type];
  if (!match) return;
  const [channel, state] = match;
  const record =
    channel === "sms" ? event.data?.text_message : event.data?.message;
  if (
    typeof record?.id !== "string" ||
    !record.id.trim() ||
    record.id.length > 256 ||
    record.direction !== "outbound"
  )
    return;
  // Mail and SMS callbacks are resource scoped. Two missing identifiers must
  // never count as a match. iMessage uses the verified identity webhook key
  // and does not normally send an identity ID in the message projection.
  const refs = [event.data?.identity_id, record.agent_identity_id];
  if (refs.some((ref) => ref != null && ref !== identity.id)) return;
  if (
    channel === "email" &&
    (!identity.mailbox?.id || record.mailbox_id !== identity.mailbox.id)
  )
    return;
  if (
    channel === "sms" &&
    (!identity.phoneNumber?.number ||
      record.local_phone_number !== identity.phoneNumber.number)
  )
    return;
  if (channel === "whatsapp" && record.agent_identity_id !== identity.id)
    return;
  if (channel === "imessage" && !identity.imessageEnabled) return;
  return { channel, message: record.id, state };
}
