# Inkbox for Pi

Give your Pi coding agent an email address and a messaging identity. Ask Pi to send a message from the terminal, or run the included gateway to reach it when the terminal is closed. The extension and the gateway are part of **one package**. Installing it does not start a background service.

## Get started

You need Node.js 22.19 or newer, [Pi](https://pi.dev/) on your PATH, and a model configured in Pi. This release targets Pi 1.6.0.

**From a source checkout** (including before the first npm release):

    npm ci
    pi install "$PWD"
    node bin/inkbox-pi.js setup

**From the Pi catalog** (once published):

    pi install npm:@inkbox/pi-plugin

Start Pi or run `/reload`. Use `/inkbox` to see the setup and gateway commands **for that installation**; Pi's package directory does not need to be on your shell PATH. Use `/inkbox-status` to see the active profile and available tools. If you installed a shell launcher, the same commands are available as `inkbox-pi`.

Setup connects an existing agent or guides you through signup and verification. It can also configure iMessage and an optional dedicated SMS number. An SMS recipient may need to text START first. Phone and realtime voice calls are not included.

## Using the extension

Try “Show my Inkbox identity,” “List my unread emails,” or “Send a text to this number.” Tools use your configured identity; outbound messaging asks for confirmation by default.

| Capability | Examples |
|---|---|
| Mail | List unread messages, inspect a thread, send email, optionally forward or mark read |
| SMS and iMessage | Read direct or group conversations, send texts and attachments |
| WhatsApp and Slack | Work with connected channels and their conversations |
| Contacts, notes and access | Look up contacts, maintain notes, inspect channel contact rules |
| Agent-to-agent tasks | Send a task, check its status and read the conversation |
| Vault | Opt in to specific credential tools; plaintext tools require exact-name enablement |

The local profile is stored under `~/.inkbox-pi` (override with `INKBOX_PI_HOME`). Use `INKBOX_API_KEY`, `INKBOX_IDENTITY`, and optionally `INKBOX_BASE_URL` to configure a process without changing the saved identity. Inside the profile's `config.json`, the optional `tools.enable` and `tools.disable` arrays accept group names or exact tool names. Keep the rest of the generated file intact. Reload Pi after changing the profile. Remote discovery and execution are limited to supported operations whose corresponding local tools are enabled.

## Running the gateway

Configure model access in Pi itself before starting a background service. The gateway listens for signed Inkbox events and starts Pi turns independently of the interactive terminal. It saves conversation history locally and routes the reply to the originating conversation. Incoming messages are not permission to use the interactive session's tools or credentials.

| Command | Purpose |
|---|---|
| `inkbox-pi doctor` | Check Pi, the identity and the webhook signing configuration |
| `inkbox-pi run` | Run in the foreground |
| `inkbox-pi start`, `status`, `stop` | Manage and inspect a background gateway |
| `inkbox-pi autostart install` | Keep the gateway running after login on Linux or macOS |
| `inkbox-pi autostart uninstall` | Remove autostart |

By default the gateway uses an Inkbox tunnel. To supply your own HTTPS endpoint, set `INKBOX_PI_PUBLIC_URL` and a fixed `INKBOX_PI_PORT` and forward `/webhook` to that port. Set `INKBOX_PI_ALLOWED_SENDERS` to a comma-separated list to narrow inbound senders. Keep your signing key private; rotating it replaces the key for the identity, not just for this installation.

In a direct conversation, send `/status` for work status, `/stop` or `/cancel` to stop work, or `/new` or `/clear` to start a fresh session. These are messages to the gateway, not commands to type at a shell. Use `INKBOX_GROUP_REPLY_MODE=mention` to limit ordinary group wake-ups to messages addressing the agent.

If your model credential exists only in a shell variable, set `INKBOX_PI_MODEL_ENV` to the **name** of the supported credential variable before installing or starting the service. The value is kept in the private service profile, not in the service definition. This isn't necessary when Pi already has a saved login.

By default incoming turns cannot read or edit project files. For a trusted agent-to-agent caller, the owner can set both `INKBOX_PI_TRUSTED_AGENT_IDS` (exact identity IDs) and `INKBOX_PI_PROJECT_FILES` (exact existing file paths relative to the project). This grants bounded read/replace tools for those files, not a general-purpose shell.

For unattended setup with an existing identity, pass its key through stdin rather than a command-line argument:

    inkbox-pi bootstrap --identity my-agent --api-key-stdin --project-dir "$PWD"

## Embedding

Import `createGatewayRuntime` from `@inkbox/pi-plugin/runtime` when your application owns event delivery and process supervision. Pass an initialized SDK client, its verified identity, and a persistent state directory. The runtime accepts **already verified** events; it is not a raw HTTP endpoint. To run the HTTP listener, signature verification, subscriptions and tunnel together, use `startGateway` instead. Don't run two owners against one profile.

Call `runtime.acceptVerified(event)` to admit an event, then inspect `runtime.eventState(event.id)` to distinguish queued work from a delivered reply or a failure. Admission alone is not a delivery receipt. Watch `runtime.failed` for a fatal runtime error and await `runtime.close()` on shutdown.

## Releases

The initial package version matches the published Inkbox SDK, **0.7.42**. The exact SDK dependency is pinned; subsequent plugin fixes can take their own patch versions. SDK dependency updates are proposed separately and checked against Pi before release.

    ./publish.sh          # verify the SDK, pack the release, and dry-run
    ./publish.sh --prod   # publish the verified package to public npm

Use an npm identity with publish access to the `@inkbox` scope. A retry accepts an existing version only if its registry integrity matches the local tarball. The `pi-package` keyword makes the released npm package eligible for the [Pi catalog](https://pi.dev/packages); there is no separate extension upload.
