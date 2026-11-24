---
name: inkbox-email-triage
description: Triage Inkbox mail and reply in the correct thread.
---

**Keep mailbox IDs, thread IDs and mail headers distinct.**

1. Get a bounded batch with `inkbox_list_unread_emails`. For older or already-read mail, use `inkbox_list_emails` and, if helpful, `direction: "inbound"`.
2. Use a row's `id` as the `messageId` argument to `inkbox_get_email` for the complete message. Use its `threadId` with `inkbox_get_email_thread` to see what has already been answered. A preview alone is not enough to act on a truncated request.
3. If asked for a draft, return draft text without sending. For an authorized send, give `inkbox_send_email` the intended `to`, `cc` and `bcc`, and use the original *RFC Message-ID* (`messageId` in the mail record, not `id`) as `inReplyToMessageId`. Preserve the subject. Do not add recipients just because they appeared earlier in the thread.
4. If asked to clear handled mail, use `inkbox_mark_emails_read` with only the processed message UUIDs. This tool and `inkbox_forward_email` are opt-in. For forwarding, review both the new audience and whether original attachments should be included.
