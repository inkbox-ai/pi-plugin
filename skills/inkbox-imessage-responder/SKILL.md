---
name: inkbox-imessage-responder
description: Check iMessage connections, read threads and send a reply.
---

Use `inkbox_list_imessage_conversations` and read the relevant conversation before replying. Use `inkbox_get_imessage_thread` for a quoted thread, not an unrelated thread ID. Reply using the existing conversation ID. Shared iMessage is recipient-first: a person must connect and write to the agent before the agent can message them. Do not silently switch to SMS.
