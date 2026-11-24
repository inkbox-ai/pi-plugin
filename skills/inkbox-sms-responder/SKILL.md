---
name: inkbox-sms-responder
description: Read and reply to SMS or group MMS from the Inkbox number.
---

Use `inkbox_list_text_conversations` and `inkbox_get_text_conversation` first. Prefer the existing conversation ID for a reply; for a new message use explicit E.164 recipients. A group MMS reaches everyone in the group. Respect opt-outs. If the gateway will deliver your final response, do not send that text again with `inkbox_send_sms`.
