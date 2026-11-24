---
name: inkbox-troubleshooting
description: Diagnose Inkbox identity, tool availability and gateway setup.
---

Use /inkbox for this installation’s executable path and /inkbox-status for redacted configuration. Run inkbox-pi doctor in a separate terminal. Use `inkbox_whoami` to verify the active identity; an identity is not a secret key. If tools are absent, inspect tools.enable and tools.disable in the profile and reload Pi. An installed package is not evidence that a gateway is running.
