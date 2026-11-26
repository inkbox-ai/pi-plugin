---
name: inkbox-sms-responder
description: Read and reply to SMS or group MMS from the Inkbox number.
---

**Identify the conversation before sending.** `inkbox_list_text_conversations` includes groups by default. Look at unread counts, participants, and the latest message; use `inkbox_get_text_conversation` for the selected `conversationId`. Older direct rows without an ID can be read by `remotePhoneNumber`; don’t use a single number to reconstruct a group.

- In interactive Pi, reply with `inkbox_send_sms` using the conversation ID, or start a new text with an explicit E.164 `to`. A list of two to eight recipients creates a group MMS visible to all. If a local allowlist rejects a conversation-addressed send, do not silently turn it into one or more direct texts.
- Keep SMS concise. Only reply in a group when the agent is addressed or has something actionable to contribute. In a gateway turn, normal final text is already delivered back to the source; do not send a second copy.
- When requested, use `inkbox_mark_text_conversation_read` for the processed conversation, if enabled. A pending or unknown delivery status is not a reason to send again. For an opt-out or missing opt-in, explain the status without switching numbers or channels.
