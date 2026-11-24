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

To replace a revoked key for the same identity, run `inkbox-pi setup --replace-key`; the masked prompt verifies the replacement before saving it.

Setup connects an existing agent or guides you through signup and verification. It can also configure iMessage and an optional dedicated SMS number. An SMS recipient may need to text START first. Phone and realtime voice calls are not included.

## Using the extension

Try “Show my Inkbox identity,” “List my unread emails,” or “Send a text to this number.” Tools use your configured identity; outbound messaging asks for confirmation by default. Without an interactive approval UI, an operation that requires confirmation is denied. This interactive tool policy is separate from the gateway replying to an admitted inbound message.

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

Configure model access in Pi itself before starting a background service. The gateway listens for signed Inkbox events and starts Pi turns independently of the interactive terminal. Startup and `inkbox-pi doctor` check for a selected model and configured credentials without sending a model prompt. Replies that exceed the messaging channel’s limit are explicitly shortened; the complete answer remains in local Pi history. It saves conversation history locally and routes the reply to the originating conversation. Incoming messages are not permission to use the interactive session's tools or credentials.

| Command | Purpose |
|---|---|
| `inkbox-pi doctor` | Check Pi, the identity and the webhook signing configuration |
| `inkbox-pi run` | Run in the foreground |
| `inkbox-pi start`, `status`, `stop` | Manage and inspect a background gateway |
| `inkbox-pi autostart install` | Keep the gateway running after login on Linux or macOS |
| `inkbox-pi autostart uninstall` | Remove autostart |

By default the gateway uses an Inkbox tunnel. To supply your own HTTPS endpoint, set `INKBOX_PI_PUBLIC_URL` and a fixed `INKBOX_PI_PORT` and forward `/webhook` to that port. Set `INKBOX_PI_ALLOWED_SENDERS` to a comma-separated list to narrow inbound senders. Keep your signing key private; rotating it replaces the key for the identity, not just for this installation.

Slack tools and gateway replies are opt-in for a connected identity. Set `INKBOX_SLACK_ENABLED=true` (or `slackEnabled: true` in the profile), then reload Pi and restart the gateway. With Slack off, even old subscriptions cannot wake Pi.

In a direct conversation, send `/status` for work status, `/stop` or `/cancel` to stop work, or `/new` or `/clear` to start a fresh session. These are messages to the gateway, not commands to type at a shell. Use `INKBOX_GROUP_REPLY_MODE=mention` to limit ordinary group wake-ups to messages addressing the agent.

If your model credential exists only in a shell variable, set `INKBOX_PI_MODEL_ENV` to the **name** of the supported credential variable before installing or starting the service. The value is kept in the private service profile, not in the service definition. This isn't necessary when Pi already has a saved login.

Incoming turns cannot read or edit project files by default. To grant bounded read/replace access, set `INKBOX_PI_PROJECT_FILES` to comma-separated, existing paths relative to the project, then grant either:

- An agent-to-agent caller: set `INKBOX_PI_TRUSTED_AGENT_IDS` to exact Inkbox identity IDs.
- A one-to-one native iMessage or WhatsApp conversation: set `INKBOX_PI_TRUSTED_CONVERSATIONS` to comma-separated `channel:conversation-id:sender-number` bindings (for example, `imessage:YOUR-CONVERSATION-ID:+12025550123`). Use the Inkbox conversation ID and the peer's full international number, not a display name. The gateway checks the identity-owned inbound message and current destination before running Pi and again before sending.

Restart the gateway after changing grants. Removing a grant or changing its file list prevents reuse of the old privileged session and suppresses its pending replies. Groups, Companion turns, SMS (including downgraded iMessage), and email never receive project tools. A grant does not enable a shell or other Pi tools.

For unattended setup with an existing identity, pass its key through stdin rather than a command-line argument:

    inkbox-pi bootstrap --identity my-agent --api-key-stdin --project-dir "$PWD"

### Incoming attachments and voice notes

Pi receives the caption and bounded file descriptions, not arbitrary attachment URLs or binary content. For messaging audio, the gateway includes available automatic transcripts and waits up to a minute for a pending transcript. Completion notifications only prompt a read of the original message; they never start another turn or supply project permissions. An unavailable transcript is labeled as such. Only the original message text can address a group or invoke a control, not a filename or transcript. Project-authorized turns use the verified message text rather than attachment instructions.

## Updating and removing

For an npm installation, run `pi update --extensions`, use `/reload` in an open Pi session, then run `inkbox-pi restart` if the gateway is in use. For a source checkout, update the checkout and run `npm ci` before reloading and restarting. Use the path from `/inkbox` if you do not have the launcher on PATH.

Before removing the package, run `inkbox-pi uninstall` to stop and remove the background service. Then run `pi remove npm:@inkbox/pi-plugin` (or pass the original source path for a local install) and `/reload`. This preserves your profile and conversation history. If you used `install.sh`, you can also remove its `inkbox-pi` symlink from your bin directory.

## Embedding

Import `createGatewayRuntime` from `@inkbox/pi-plugin/runtime` when your application owns event delivery and process supervision. Pass an initialized SDK client, its verified identity, and a persistent state directory. The runtime accepts **already verified** events; it is not a raw HTTP endpoint. To run the HTTP listener, signature verification, subscriptions and tunnel together, use `startGateway` instead. Don't run two owners against one profile.

For example, with an existing verified SDK identity and client:

```ts
import { createGatewayRuntime } from "@inkbox/pi-plugin/runtime";

const runtime = createGatewayRuntime(
  { home: stateDirectory, baseUrl: apiOrigin, projectDirectory },
  { client, identity },
);
// Inside the listener, after verifying the signature of the raw request:
runtime.acceptVerified(event);
```

Call `runtime.acceptVerified(event)` to admit an event, then inspect `runtime.eventState(event.id)` to distinguish queued work from a delivered reply or a failure. Admission alone is not a delivery receipt. If a job fails, `runtime.lastFailure(event.id)` returns its most recent sanitized failure category and attempt number. Watch `runtime.failed` for a fatal runtime error and await `runtime.close()` on shutdown.

A signed `inbound.received` event with an agent handler runs in a session dedicated to its source. If `INKBOX_PI_ALLOWED_SENDERS` is set, include the source ID to accept its events. Request bodies up to 64 KiB are passed as data; a completed analysis is available through `runtime.eventResult(event.id)`, not sent to the requester. With the standalone gateway, use `inkbox-pi event EVENT_ID` with the outer webhook event ID to inspect its local result or delivery state. `inkbox-pi doctor` also reports local job counts separately from background-service readiness. Script handlers are not executed. Unsupported handlers and exhausted processing retries are reported against the originating delivery.

## Releases

The initial package version matches the published Inkbox SDK, **0.7.42**. The exact SDK dependency is pinned; subsequent plugin fixes can take their own patch versions. SDK dependency updates are proposed separately and checked against Pi before release.

    ./publish.sh          # verify the SDK, pack the release, and dry-run
    ./publish.sh --prod   # publish the verified package to public npm

Run the release command from the merged repository checkout. Use an npm identity with publish access to the `@inkbox` scope. A retry accepts an existing version only if its registry integrity matches the local tarball. The `pi-package` keyword makes the released npm package eligible for the [Pi catalog](https://pi.dev/packages); there is no separate extension upload.
