---
name: inkbox-imessage-responder
description: Check iMessage connections, read threads and send a reply.
---

**Start with the existing conversation, not a guessed phone number.** Use `inkbox_list_imessage_conversations`, then `inkbox_get_imessage_conversation` with the chosen `conversationId`. For a quoted thread use `inkbox_get_imessage_thread` with the source message ID. If you already have an opaque thread ID, use `inkbox_get_imessage_conversation_thread` with both the conversation and thread IDs.

- In an interactive Pi session, an authorized reply uses `inkbox_send_imessage` with `conversationId`. Use `to` instead only for an explicit destination; the two selectors are mutually exclusive. Starting a new group requires a dedicated outbound iMessage line.
- On the shared line the person must connect and message this agent first. If they have not connected, the optional `inkbox_imessage_triage_number` tool returns the actual router number and connect command; don’t invent either. A released assignment needs reconnection, not a fallback SMS.
- A reaction or read receipt is visible to the other party. Use the optional reaction or mark-read tool only when appropriate; don’t acknowledge an entire conversation merely to inspect it.
