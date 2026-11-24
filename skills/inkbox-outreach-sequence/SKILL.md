---
name: inkbox-outreach-sequence
description: Continue a user-authorized sequence of email or text follow-ups.
---

**Track a sequence as a small list of explicit steps.** Record the intended recipient and channel, the agreed cadence, what has already been sent, and the condition that ends follow-up. A gap in message history is not authorization for a new channel or a longer sequence.

At each scheduled or user-requested step:

1. Reopen the original thread: `inkbox_get_email_thread` for mail or `inkbox_get_text_conversation` for SMS. Check newer inbound messages before sending anything. A reply, opt-out or changed instruction can end the sequence.
2. If the step is due and authorized, send only that step. Keep email threaded using the prior RFC Message-ID; continue SMS using its conversation ID. Do not resend an earlier step just because this Pi session has no local memory of it.
3. Record the accepted message ID and next due step in the user’s chosen tracker. For an uncertain send, inspect history before deciding what to do next. Distinguish accepted from delivered.

Pi does not schedule future outreach by describing a plan. Without a configured scheduler, tell the user when to resume rather than promising an automatic send.
