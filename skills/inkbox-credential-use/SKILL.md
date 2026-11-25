---
name: inkbox-credential-use
description: Use identity-scoped vault access when the user asks to use a saved credential.
---

**Choose the narrowest vault tool for the requested operation.**

1. Use `inkbox_credentials_list` to locate the shared credential by its name and type. The result is metadata, not the secret. If there are several plausible matches, clarify the account before reading any payload.
2. A login uses `inkbox_credentials_get_login`; an API credential uses `inkbox_credentials_get_api_key`; an SSH credential uses `inkbox_credentials_get_ssh_key`. Pass the selected `secretId`. For a one-time login code, use `inkbox_totp_code` near the point of use, not a generic secret read.
3. Plaintext tools require exact-name entries in the profile’s `tools.enable`; enabling the entire `vault` group does not enable them. If the vault is locked, the user sets `INKBOX_PI_VAULT_KEY` in the environment that launches Pi. Do not request the key in chat. The key is not passed to a gateway turn, so credential tools stay locked when the request arrived as a message; say so instead of asking for the key.

Use credentials for the authorized account and action. Report the result, not the credential, and do not put it in an Inkbox message or note.
