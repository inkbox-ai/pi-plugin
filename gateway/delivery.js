const NOTIFICATIONS = {
  "message.failed": ["email", "failed"], "message.bounced": ["email", "failed"],
  "text.delivery_failed": ["sms", "failed"], "text.delivery_unconfirmed": ["sms", "uncertain"],
  "imessage.delivery_failed": ["imessage", "failed"], "whatsapp.delivery_failed": ["whatsapp", "failed"],
  "whatsapp.delivery_unconfirmed": ["whatsapp", "uncertain"]
};

export function deliveryNotification(event, identity) {
  const match = Object.hasOwn(NOTIFICATIONS, event.event_type) && NOTIFICATIONS[event.event_type];
  if (!match) return;
  const [channel, state] = match;
  const record = channel === "sms" ? event.data?.text_message : event.data?.message;
  if (typeof record?.id !== "string" || !record.id || record.direction !== "outbound") return;
  if (channel === "email" && record.mailbox_id !== identity.mailbox?.id) return;
  if (channel === "sms" && record.local_phone_number !== identity.phoneNumber?.number) return;
  if (channel === "whatsapp" && record.agent_identity_id !== identity.id) return;
  if (channel === "imessage" && event.data.identity_id && event.data.identity_id !== identity.id) return;
  return { channel, message: record.id, state };
}
