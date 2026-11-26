---
name: inkbox-outbound-calling
description: Place a phone call from the Inkbox identity and handle its result.
---

**Calls are conducted by Inkbox's call agent.** `inkbox_place_call` starts the call and hands it a task; you do not speak on the call yourself.

- Write a concrete `purpose`: who is being called, the outcome wanted, and the facts needed to get there. The call agent knows only what the purpose, `openingMessage` and `context` tell it.
- Use an E.164 `toNumber`. Take it from the routing tag or a contact lookup; never guess a number.
- Call SMS and phone contacts from your own number (`origination: "dedicated_number"`, the default). To call someone you message on iMessage, use the iMessage line; a shared iMessage line only reaches people already connected to you over iMessage.
- A placed call is not a completed call. Say the call was started, not that it succeeded. The result arrives later as a finished-call report with the outcome and transcript.
- If the call is rejected, report the reason. Do not retry with a different number or line unless asked.
