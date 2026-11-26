# Changelog

## [0.7.42]

- Add native Pi messaging tools and skills backed by Inkbox SDK 0.7.42.
- Connect an existing identity or create one with guided setup.
- Receive signed messages in a foreground or background gateway and resume the corresponding Pi conversation.
- Run every messaging turn and agent-to-agent task in the project directory with Pi's own tools and the configured Inkbox tools. Context files and skills load, and the reply is delivered to the originating conversation.
- Ask the person in the conversation before a Pi tool outside the read-only defaults runs, and before an outbound Inkbox send when `outbound.approval` is `ask`. They answer with a short reply: allow once, always allow for the session, or decline. Turns with nobody to ask, such as agent-to-agent tasks, run no Pi tool and keep the Inkbox tools that need no confirmation.
- Add phone calls through Inkbox’s call agent: `inkbox_place_call`, `inkbox_list_calls` and `inkbox_list_call_transcripts`, call answering during setup, and a finished-call report that Pi follows up on the line the call used (SMS for the phone number, iMessage for an iMessage line), with replies and approvals handled there.
- Add `yolo` (`INKBOX_PI_YOLO`): run every tool in every messaging turn without asking. Setup asks, defaulting to no.
- Add `autoApproveInkboxTools` (`INKBOX_PI_AUTO_APPROVE_INKBOX_TOOLS`): run Inkbox tools without the per-send question while Pi’s own command and file tools keep asking. Setup asks, defaulting to yes; unattended setup turns it on unless a choice was saved.
- Tell the agent who it is talking to: each incoming message carries a routing tag with the channel, sender and resolved contact, followed by the contact's memories when available.
- Keep one session per known contact across email, SMS, iMessage and WhatsApp. Groups, Slack, agent-to-agent tasks and unknown senders keep a session per conversation.
- Retry a turn that never started in Pi, and never rerun one that was interrupted after it started, since it may already have acted.
- Surface failed or unconfirmed replies on the next turn without waking Pi or sending a duplicate.
