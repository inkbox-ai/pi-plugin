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

Start Pi or run `/reload`. Use `/inkbox` to see the setup and gateway commands **for that installation**; Pi's package directory does not need to be on your shell PATH. Use `/inkbox-status` to see the active profile and available tools. If you want a shell launcher, run `./install.sh --git` from a checkout before npm publication, or `./install.sh` after publication. This installs the Pi package and links `inkbox-pi` to the same copy. Otherwise use the installation-specific command shown by `/inkbox`.

To replace a revoked key for the same identity, run `inkbox-pi setup --replace-key`; the masked prompt verifies the replacement before saving it.

Setup connects an existing agent or guides you through signup and verification. It can also configure iMessage and an optional dedicated SMS number. An SMS recipient may need to text START first. Phone and realtime voice calls are not included.

## Using the extension

Try “Show my Inkbox identity,” “List my unread emails,” or “Send a text to this number.” Tools use your configured identity; outbound messaging asks for confirmation by default. Without an interactive approval UI, an operation that requires confirmation is denied. In a gateway turn the same confirmation is sent to the person in the conversation instead; see [Approvals](#approvals).

| Capability | Examples |
|---|---|
| Mail | List unread messages, inspect a thread, send email, optionally forward or mark read |
| SMS and iMessage | Read direct or group conversations, send texts and attachments |
| WhatsApp and Slack | Work with connected channels and their conversations |
| Contacts, notes and access | Look up contacts, maintain notes, inspect channel contact rules |
| Agent-to-agent tasks | Send a task, check its status and read the conversation |
| Vault | Opt in to specific credential tools; plaintext tools require exact-name enablement |

The local profile is stored under `~/.inkbox-pi` (override with `INKBOX_PI_HOME`). Use `INKBOX_API_KEY`, `INKBOX_IDENTITY`, and optionally `INKBOX_BASE_URL` to configure a process without changing the saved identity. Inside the profile's `config.json`, the optional `tools.enable` and `tools.disable` arrays accept group names or exact tool names. Keep the rest of the generated file intact. Reload Pi after changing the profile. Remote discovery and execution are limited to supported operations whose corresponding local tools are enabled. The remote tools do not expose every new server operation automatically.

To restrict sends to specific recipients, set `outbound` in that profile:

```json
{
  "outbound": {
    "approval": "allowlist",
    "allowedRecipients": ["owner@example.com", "+12025550123"]
  }
}
```

`ask` (default) asks before each send: in Pi's terminal, or in the conversation during a gateway turn. `allowlist` permits only listed destinations without asking and requires at least one; `auto` permits without asking. A nonempty recipient list restricts destinations even in `ask` or `auto` mode. The gateway also enforces the recipient list on its own replies.

## Running the gateway

The gateway listens for signed Inkbox events and starts a Pi turn for each admitted message, independently of the interactive terminal. Configure model access in Pi itself before starting a background service. Startup and `inkbox-pi doctor` check for a selected model and configured credentials without sending a model prompt.

| Command | Purpose |
|---|---|
| `inkbox-pi doctor` | Check Pi, the identity and the webhook signing configuration |
| `inkbox-pi run` | Run in the foreground |
| `inkbox-pi start`, `status`, `stop` | Manage and inspect a background gateway |
| `inkbox-pi autostart install` | Keep the gateway running after login on Linux or macOS |
| `inkbox-pi autostart uninstall` | Remove autostart |

By default the gateway uses an Inkbox tunnel. To supply your own HTTPS endpoint, set `INKBOX_PI_PUBLIC_URL` and a fixed `INKBOX_PI_PORT` and forward `/webhook` to that port. Set `INKBOX_PI_ALLOWED_SENDERS` to a comma-separated list to narrow inbound senders. Keep your signing key private; rotating it replaces the key for the identity, not just for this installation.

Slack tools and gateway replies are opt-in for a connected identity. Set `INKBOX_SLACK_ENABLED=true` (or `slackEnabled: true` in the profile), then reload Pi and restart the gateway. With Slack off, even old subscriptions cannot wake Pi.

If your model credential exists only in a shell variable, set `INKBOX_PI_MODEL_ENV` to the **name** of the supported credential variable before installing or starting the service. The value is kept in the private service profile, not in the service definition. This isn't necessary when Pi already has a saved login.

For unattended setup with an existing identity, pass its key through stdin rather than a command-line argument:

    inkbox-pi bootstrap --identity my-agent --api-key-stdin --project-dir "$PWD"

### What a messaging turn does

Every admitted email, SMS, iMessage, WhatsApp or Slack message, and every agent-to-agent task, runs one Pi turn in the configured project directory (the one chosen during setup, or `INKBOX_PI_PROJECT_DIR`). The turn has Pi’s own tools (`read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`) and the Inkbox tools enabled in the profile, which act with the gateway’s API key. The tools are the same on every channel. Turns with nobody to ask for approval are the exception described under [Approvals](#approvals).

- **Prompt and context.** Pi keeps its own system prompt, including a `SYSTEM.md` or `APPEND_SYSTEM.md` in your Pi agent directory. Context files such as `AGENTS.md` load, and so do the skills in your Pi agent directory and this package’s skills. Inkbox appends guidance for writing on messaging channels and the agent’s own addresses; it does not replace the agent’s persona. Your other Pi extensions, prompt templates, themes and project-local `.pi` configuration are not loaded.
- **Replies.** Pi’s final answer is delivered automatically to the conversation the message came from. Markdown is removed on SMS, iMessage and WhatsApp. A reply that exceeds the channel’s limit is explicitly shortened; the complete answer remains in local Pi history. When the agent answers with exactly `[SILENT]`, nothing is sent. The send tools are for reaching a different recipient or channel, such as “email me the full report.”
- **Interrupted turns.** A turn can run for up to 30 minutes, not counting time spent waiting for an approval answer. A turn that never started in Pi is retried. A turn that started and then ends early, because Pi failed, the turn was stopped or the gateway restarted, is never run again, since it may already have acted. Whatever it did remains.
- **Delivery status.** A failed or unconfirmed delivery does not wake Pi or resend a reply. On that sender’s next turn in the same session, Pi receives a short delivery-status note. Clearing the session also clears pending notes.

### Who the agent is talking to

Pi receives each incoming message with a routing tag on its first line:

    [inkbox:sms from=+12025550123 conversation_id=CONVERSATION-ID | contact_id=CONTACT-ID contact_name="Alex Doe" contact_phones=+12025550123]

- **Routing.** The tag names the channel, the sender and the conversation. A group conversation has a `group_` prefix on the channel (`inkbox:group_sms`) and lists its `participants`. Email carries the `subject` and its `message_id` instead of a conversation ID; Slack adds `connection_id` and, in a thread, `thread_ts`. An agent-to-agent task is tagged `[inkbox:a2a_task caller=@handle task_id=TASK-ID]`.
- **Contact card.** The part after `|` describes the sender. The gateway looks up the sender’s exact email address or phone number in the identity’s contacts; a single match supplies the contact’s ID, name, company, email addresses and phone numbers. Without one, a one-to-one conversation uses the contact or peer agent Inkbox attached to the event; a group does not, because the event does not say which member that entry names. With neither, the card is `contact=unknown_in_inkbox`. Lookups are cached for five minutes. On Slack the card carries only a contact ID, when Inkbox attached one to the event; the sender’s Slack display name, real name, email and title follow on a separate line when Slack supplied them.
- **Contact memories.** In a one-to-one conversation on email, SMS, iMessage or WhatsApp, the memories Inkbox supplies for that contact follow the tag in an `[inkbox:contact_memories]` block, marked as background context rather than instructions. They are included by default. To leave them out, set `contactMemories` to `false` in the profile or `INKBOX_CONTACT_MEMORIES_ENABLED=false`.

### Approvals

Tools that only read files run without a question; by default these are Pi’s `read`, `grep`, `find` and `ls`. Two kinds of action first ask the person in the conversation:

- any other Pi tool, such as `bash`, `edit` or `write`;
- an Inkbox tool that sends something or is visible to someone else, when `outbound.approval` is `ask` (the default): emails and forwards, texts, iMessage, WhatsApp and Slack messages, reactions, iMessage read receipts, file uploads, agent-to-agent calls and remote write operations.

The other Inkbox tools do not ask. This includes reading mail, message history, contacts and notes, and creating, changing or deleting contacts and notes.

The question arrives as an ordinary message in the same conversation:

    Permission needed: run the command: npm test

    Reply 1 to allow once, 2 to always allow (this conversation), or 3 to decline.

| Reply | Also accepted | Effect |
|---|---|---|
| `1` | `y`, `yes`, `yes please go ahead`, `ok`, `okay`, `approve`, `allow`, `sure`, `go`, `go ahead` | Allow this one action |
| `2` | `always`, `allow always`, `always allow`, `yes always` | Allow it, and stop asking that person about the same thing for the rest of the session |
| `3` | `n`, `no`, `deny`, `decline`, `reject`, `block`, `stop`, `cancel`, `don't`, `dont` | Decline |

- **What is shown.** The request is shown as it will run, unaltered apart from control characters: a shell command in full, and any other Pi tool with its full arguments, except that `write` and `edit` name the file and not the content. An Inkbox send shows the tool, the recipients and details such as the subject, length or attachments, not the message text. A request longer than 1,200 characters is cut there and ends with `[N more characters not shown]`, giving the number that is hidden.
- **Who can answer.** Only a reply in the same conversation, from the same address that was asked, answers the question. A message from that person on another channel does not answer it, even when both channels share a session; neither does a message from anyone else. Such a message is handled as a normal message and the question stays open.
- **How to answer.** The answer must be the whole message. Capitalization and a final `.` or `!` are ignored, and so is a mention of the agent in front of it. In an email, send only the answer; quoted history below it is ignored. Any other message from that address in that conversation declines the question and is then handled as a normal message.
- **Groups.** In a group with `groupReplyMode` set to `mention`, the answer must mention the agent like any other message to it, and the question says so: `Include @agent in your answer (for example, @agent allow).`
- **SMS.** `stop` and `cancel` are carrier keywords, which the gateway ignores. Reply `3` or `no` instead.
- **Timeout.** A question that is not answered within the timeout (10 minutes by default) counts as declined.
- **Always.** “Always” is remembered for the address that answered, within the session of that conversation, in memory: it ends with `/clear`, `/new` or a gateway restart. For a Pi tool it covers every later use of that tool, so answering `2` to one `bash` question allows all later commands. For an Inkbox send it covers the same tool and the same recipients.
- **Nobody to ask.** Agent-to-agent tasks and sponsored group members, including everyone in a Companion group conversation, have nobody who can approve. No question is sent, and no Pi tool runs in those turns at all, not even `read`. The Inkbox tools that need no confirmation still work.

Set these in the profile’s `config.json`, or in the environment of the command that starts the gateway, then restart it (`inkbox-pi restart` for a background gateway):

| Profile setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `autoApproveInkboxTools` | `INKBOX_PI_AUTO_APPROVE_INKBOX_TOOLS` | `false` (setup asks, defaulting to yes; `bootstrap` saves `true`) | Run Inkbox tools without the question before each send, in the terminal and in messaging turns. Pi’s own tools still ask, and `outbound.allowedRecipients` still applies. |
| `autoAllowedTools` | `INKBOX_PI_AUTO_ALLOWED_TOOLS` (comma-separated) | `read`, `grep`, `find`, `ls` | Pi tools that run without asking when someone can be asked. With an empty list every Pi tool asks. |
| `permissionTimeoutS` | `INKBOX_PERMISSION_TIMEOUT_S` | `600` | Seconds an approval question waits for an answer, from 10 to 1500. |
| `outbound.approval` | (profile only) | `ask` | `ask`, `allowlist` or `auto`, as described under [Using the extension](#using-the-extension). |
| `outbound.allowedRecipients` | (profile only) | empty | When nonempty, the only destinations a send or a gateway reply may reach. |

### Who can use the agent

Anyone admitted by the identity’s contact rules, and by `allowedSenders` when it is set, can ask the agent to act and can approve the agent’s requests in their own conversation. There is no separate owner: the person who sent the message is the person who is asked. The exceptions are agent-to-agent tasks and sponsored group members, who can ask but are never offered an approval.

- Pi’s tools run as the operating-system user that runs the gateway. The project directory is where they start, not a boundary. With the defaults, a person who can approve can have the agent read any file that user can read, including this profile’s API key, without a question, and can approve shell commands and file edits by replying `1`.
- The Inkbox tools that do not ask are available to every admitted sender, including agent-to-agent tasks and sponsored group members. They can have the agent read the identity’s mail, message history, contacts and notes, and change contacts and notes.
- An email sender is identified by the From address Inkbox reports for the message. The gateway adds no challenge of its own.
- Restrict who can reach the identity with its contact rules in Inkbox. In addition, set `INKBOX_PI_ALLOWED_SENDERS` (or `allowedSenders` in the profile) to the exact email addresses and phone numbers the gateway should answer. Write a Slack sender as `TEAM-ID:USER-ID` and a calling agent by its handle.
- `autoApproveInkboxTools` lets every admitted sender, including agent-to-agent tasks and sponsored group members, have the agent send email and messages as the identity without a question. Leave it off, or set `outbound.allowedRecipients`, when the identity is reachable by people you would not let send on its behalf.
- Keep the approval list tight. Every tool added to `autoAllowedTools` runs with no question for every sender who can approve. `outbound.approval: "auto"` removes the question for sends from every admitted sender, including agent-to-agent tasks and sponsored group members. Use `outbound.allowedRecipients` to bound where messages can go.
- Credential (vault) tools stay locked in gateway turns, because `INKBOX_PI_VAULT_KEY` is not passed to them.

### Sessions and controls

A sender that resolves to one of your contacts, on the event itself or by the address-book lookup, has one session across one-to-one email, SMS, iMessage and WhatsApp, so the agent keeps its context when that person changes channel. Groups, Slack conversations and threads, agent-to-agent tasks, and senders with no contact each have a session per conversation. Unaddressed group messages suppressed by mention mode are not saved as conversation context. History is saved locally in the profile directory.

In a direct conversation, send `/status` for work status, `/stop` or `/cancel` to stop work, or `/new` or `/clear` to start a fresh session. These are messages to the gateway, not commands to type at a shell. They act only on the sender’s own session and are not available in group conversations or to agent-to-agent tasks. `/stop` asks Pi to end the commands it is running, and forces Pi to exit if it is still running three seconds later. Stopping a turn does not undo what it already did. Use `INKBOX_GROUP_REPLY_MODE=mention` to limit ordinary group wake-ups to messages addressing the agent.

### Incoming attachments and voice notes

Pi receives the caption and bounded file descriptions, not arbitrary attachment URLs or binary content. For messaging audio, the gateway includes available automatic transcripts and waits up to a minute for a pending transcript. Completion notifications only prompt a read of the original message; they never start another turn or answer an approval question. An unavailable transcript is labeled as such. Only the original message text can address a group, invoke a control or answer an approval question, not a filename or transcript.

## Updating and removing

For an npm installation, run `pi update --extensions`, use `/reload` in an open Pi session, then run `inkbox-pi restart` if the gateway is in use. For a source checkout, update the checkout and run `npm ci` before reloading and restarting. Use the path from `/inkbox` if you do not have the launcher on PATH.

Before removing the package, run `inkbox-pi uninstall` to stop and remove the background service. Then run `pi remove npm:@inkbox/pi-plugin` (or pass the original source path for a local install) and `/reload`. This preserves your profile and conversation history. If you used `install.sh`, you can also remove its `inkbox-pi` symlink from your bin directory.

## Embedding

Import `createGatewayRuntime` from `@inkbox/pi-plugin/runtime` when your application owns event delivery and process supervision. Pass an initialized SDK client, its verified identity, a persistent state directory, and the identity’s API key for the Inkbox tools of each turn. The runtime accepts **already verified** events; it is not a raw HTTP endpoint. To run the HTTP listener, signature verification, subscriptions and tunnel together, use `startGateway` instead. Don't run two owners against one profile.

For example, with an existing verified SDK identity and client:

```ts
import { createGatewayRuntime } from "@inkbox/pi-plugin/runtime";

const runtime = createGatewayRuntime(
  { home: stateDirectory, baseUrl: apiOrigin, projectDirectory, apiKey },
  { client, identity },
);
// Inside the listener, after verifying the signature of the raw request:
runtime.acceptVerified(event);
```

The same configuration accepts `tools`, `outbound`, `allowedSenders`, `autoAllowedTools`, `permissionTimeoutS` and `contactMemories`, with the meanings described above. Everything under [Who can use the agent](#who-can-use-the-agent) applies to an embedded runtime too.

Call `runtime.acceptVerified(event)` to admit an event, then inspect `runtime.eventState(event.id)` to distinguish queued work from a delivered reply or a failure. Admission alone is not a delivery receipt. If a job fails, `runtime.lastFailure(event.id)` returns its most recent sanitized failure category and attempt number. Watch `runtime.failed` for a fatal runtime error and await `runtime.close()` on shutdown.

A signed `inbound.received` event with an agent handler runs in a session dedicated to its source, without tools and without approval questions. If `INKBOX_PI_ALLOWED_SENDERS` is set, include the source ID to accept its events. Request bodies up to 64 KiB are passed as data; a completed analysis is available through `runtime.eventResult(event.id)`, not sent to the requester. With the standalone gateway, use `inkbox-pi event EVENT_ID` with the outer webhook event ID to inspect its local result or delivery state. `inkbox-pi doctor` also reports local job counts separately from background-service readiness. Script handlers are not executed. Unsupported handlers and exhausted processing retries are reported against the originating delivery.

## Releases

The initial package version matches the published Inkbox SDK, **0.7.42**. The exact SDK dependency is pinned; subsequent plugin fixes can take their own patch versions. SDK dependency updates are proposed separately and checked against Pi before release.

    ./publish.sh          # verify the SDK, pack the release, and dry-run
    ./publish.sh --prod   # publish the verified package to public npm

Run the release command from the merged repository checkout. Use an npm identity with publish access to the `@inkbox` scope. A retry accepts an existing version only if its registry integrity matches the local tarball. The `pi-package` keyword makes the released npm package eligible for the [Pi catalog](https://pi.dev/packages); there is no separate extension upload.
