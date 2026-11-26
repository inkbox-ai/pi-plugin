---
name: inkbox-contact-rules
description: Inspect channel-specific Inkbox contact rules.
---

**Start with the channel on which the person tried to reach this identity.** These are three independent read-only tools:

| Channel | Tool | What to match |
| --- | --- | --- |
| Email | `inkbox_list_mail_contact_rules` | Exact address and domain |
| SMS | `inkbox_list_phone_contact_rules` | Exact phone number |
| iMessage | `inkbox_list_imessage_contact_rules` | Rule for the iMessage address |

Use the tool's `action` and `matchType` filters when the user asks for a specific kind of rule. For “why didn't this arrive?”, inspect both allow and block entries, following `limit` and `offset` as needed. Report the matched value and channel. No matching rule is not proof that a message was delivered.

If the user wants to add or remove a rule, report the existing rule and direct them to their Inkbox settings. Listing rules does not modify them, change a contact, or opt someone in to outbound messaging.
