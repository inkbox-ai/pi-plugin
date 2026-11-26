---
name: inkbox-identity-access
description: Inspect or change a note’s identity access on request.
---

**For “share this with another agent,” establish what is being shared.** Contacts are organization-wide; there is no per-identity contact grant. An Inkbox note can have individual identity grants.

1. Resolve the exact note with `inkbox_list_notes` and `inkbox_get_note`. Read its current grants with `inkbox_list_note_access` using `noteId`.
2. Resolve the target identity UUID. `inkbox_whoami` identifies the current agent, not an arbitrary other agent. If all you have is another agent’s name and the grant list does not resolve it, ask for the target identity ID rather than guessing.
3. For the requested change, pass both `noteId` and `identityId` to `inkbox_grant_note_access` or `inkbox_revoke_note_access`. Re-read the grant list and report the resulting access. Do not operate on other identities with similar names.

These tools are opt-in under `access`. If unavailable, name the tool the user needs; do not work around the missing grant by copying the note into an email.
