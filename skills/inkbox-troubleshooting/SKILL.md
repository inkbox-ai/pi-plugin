---
name: inkbox-troubleshooting
description: Diagnose Inkbox identity, tool availability and gateway setup.
---

**First distinguish the interactive extension from the background gateway.**

| Symptom | What to check |
| --- | --- |
| Pi shows no Inkbox commands | Check that the package is installed in the active Pi profile and reload Pi. `/inkbox` shows commands using this installation’s executable path, even if `inkbox-pi` is not on the shell PATH. |
| Wrong sender or no tools work | `/inkbox-status` reports local configuration without secrets. `inkbox_whoami` verifies the live identity. If it differs from the intended identity, fix setup before sending. |
| A particular tool is absent | `inkbox_doctor` reports enabled and disabled names. Preserve existing entries when editing `tools.enable` or `tools.disable` in the profile, then reload Pi. |
| Interactive tools work, but incoming messages get no reply | From the same profile, run `inkbox-pi doctor` and `inkbox-pi status`. Check model and identity readiness, the signing key, and whether the gateway is running. Check allowed senders and whether a group message addressed the agent. |
| A message may already have been sent | Inspect its conversation history or the returned operation ID before retrying. Report the observed state rather than guessing from the absence of a reply. |

When reporting a problem, include the command or tool name, channel, and sanitized error. Never include API keys, signing keys, vault contents, or the entire configuration file.
