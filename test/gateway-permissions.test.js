import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayRuntime } from "../gateway/runtime.js";
import { digest } from "../gateway/channels.js";
import { permissionPrompt } from "../gateway/permissions.js";
import { frameInbound } from "../gateway/prompts.js";

const AGENT_NUMBER = "+12025550101";
const ALEX = "+12025550102";
const SAM = "+12025550103";
const ACTION = { key: "bash", summary: "run the command: npm test" };
const QUESTION = permissionPrompt(ACTION.summary);

// `conversations` maps an SMS conversation id to its remote participants.
function agent(conversations = { direct: [ALEX] }, extra = {}) {
  return {
    id: "agent-test",
    agentHandle: "fixture",
    phoneNumber: { number: AGENT_NUMBER },
    async listTextConversations() {
      return Object.entries(conversations).map(([id, participants]) => ({
        id,
        isGroup: participants.length > 1,
        remotePhoneNumber: participants.length > 1 ? null : participants[0],
        participants,
      }));
    },
    ...extra,
  };
}

function sms(
  id,
  text,
  { conversation = "direct", from = ALEX, contacts } = {},
) {
  return {
    id: "evt-" + id,
    event_type: "text.received",
    data: {
      ...(contacts ? { contacts } : {}),
      text_message: {
        id,
        conversation_id: conversation,
        direction: "inbound",
        text,
        sender_phone_number: from,
        local_phone_number: AGENT_NUMBER,
      },
    },
  };
}

// Appends to the turn's session file and returns what earlier turns left there.
async function remember(file, entry) {
  let history = "";
  try {
    history = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(file, history + entry + ";", { mode: 0o600 });
  return history;
}

async function until(check, what) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Let the call that satisfied the check return to its caller first.
  await new Promise((resolve) => setImmediate(resolve));
}

async function gateway(
  t,
  { identity = agent(), client = {}, config, turn, reply },
) {
  const home = await mkdtemp(join(tmpdir(), "inkbox-pi-permissions-"));
  const sent = [],
    turns = [],
    unattended = [];
  const runtime = createGatewayRuntime(
    { home, ...config },
    {
      identity,
      client,
      logger: { error() {} },
      async turn(_config, route, file, signal, askPermission) {
        turns.push(structuredClone(route));
        unattended.push(askPermission.unattended === true);
        return turn({ route, file, signal, askPermission });
      },
      async reply(route, text, key) {
        sent.push({
          channel: route.channel,
          message: route.message,
          text,
          key,
        });
        return reply?.(route, text);
      },
    },
  );
  t.after(async () => {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    runtime,
    sent,
    turns,
    unattended,
    texts: () => sent.map((message) => message.text),
    finished: (id) =>
      until(
        () => runtime.eventState("evt-" + id) === "done",
        id + " to finish",
      ),
  };
}

// Asks before answering any message that mentions the tests.
async function askingTurn({ route, file, askPermission }) {
  await remember(file, route.message);
  if (!/tests/i.test(route.text)) return "Noted.";
  return "Decision: " + (await askPermission(ACTION));
}

test(
  "an approval question goes to the conversation and the sender's next message answers it",
  { timeout: 8000 },
  async (t) => {
    const { runtime, sent, turns, unattended, texts, finished } = await gateway(
      t,
      { turn: askingTurn },
    );
    assert.equal(
      runtime.acceptVerified(sms("ask", "Run the tests")),
      "accepted",
    );
    await until(() => sent.length === 1, "the question");
    assert.deepEqual(texts(), [QUESTION]);
    assert.equal(sent[0].message, "ask");
    assert.equal(runtime.eventState("evt-ask"), "running");

    assert.equal(runtime.acceptVerified(sms("answer", "1")), "accepted");
    // Consumed at admission: it is never queued for the model.
    assert.equal(runtime.eventState("evt-answer"), "done");
    await finished("ask");
    assert.deepEqual(texts(), [QUESTION, "Decision: once"]);
    assert.notEqual(sent[0].key, sent[1].key);
    assert.deepEqual(
      turns.map((route) => route.text),
      ["Run the tests"],
    );
    assert.deepEqual(unattended, [false]);
    assert.equal(runtime.acceptVerified(sms("answer", "1")), "duplicate");
    assert.equal(runtime.eventResult("evt-answer"), null);
  },
);

test(
  "a message that is not an answer declines the question and is then handled as a turn",
  { timeout: 8000 },
  async (t) => {
    const { runtime, sent, turns, texts, finished } = await gateway(t, {
      turn: askingTurn,
    });
    runtime.acceptVerified(sms("ask", "Run the tests"));
    await until(() => sent.length === 1, "the question");
    assert.equal(
      runtime.acceptVerified(sms("other", "Actually, never mind")),
      "accepted",
    );
    assert.equal(runtime.eventState("evt-other"), "queued");
    await finished("other");
    assert.equal(runtime.eventState("evt-ask"), "done");
    assert.deepEqual(texts(), [QUESTION, "Decision: reject", "Noted."]);
    assert.deepEqual(
      turns.map((route) => route.text),
      ["Run the tests", "Actually, never mind"],
    );
  },
);

test(
  "always allow lasts for the conversation's session and ends with /clear",
  { timeout: 8000 },
  async (t) => {
    const { runtime, sent, texts, finished } = await gateway(t, {
      turn: askingTurn,
    });
    runtime.acceptVerified(sms("first", "Run the tests"));
    await until(() => sent.length === 1, "the first question");
    runtime.acceptVerified(sms("always", "2"));
    await finished("first");
    runtime.acceptVerified(sms("second", "Run the tests again"));
    await finished("second");
    assert.deepEqual(texts(), [QUESTION, "Decision: always", "Decision: once"]);

    runtime.acceptVerified(sms("reset", "/clear"));
    await finished("reset");
    assert.match(sent[3].text, /cleared/);
    runtime.acceptVerified(sms("third", "Run the tests once more"));
    await until(() => sent.length === 5, "the question after the reset");
    assert.equal(sent[4].text, QUESTION);
    runtime.acceptVerified(sms("decline", "3"));
    await finished("third");
    assert.equal(sent[5].text, "Decision: reject");
  },
);

test(
  "another participant cannot answer the sender's question",
  { timeout: 8000 },
  async (t) => {
    const { runtime, sent, turns, texts, finished } = await gateway(t, {
      identity: agent({ group: [ALEX, SAM] }),
      turn: askingTurn,
    });
    const inGroup = { conversation: "group" };
    runtime.acceptVerified(sms("ask", "Run the tests", inGroup));
    await until(() => sent.length === 1, "the question");
    assert.equal(
      runtime.acceptVerified(sms("sam", "1", { ...inGroup, from: SAM })),
      "accepted",
    );
    assert.equal(runtime.eventState("evt-sam"), "queued");
    assert.equal(runtime.eventState("evt-ask"), "running");
    assert.equal(sent.length, 1);

    runtime.acceptVerified(sms("alex", "1", inGroup));
    assert.equal(runtime.eventState("evt-alex"), "done");
    await finished("sam");
    assert.deepEqual(texts(), [QUESTION, "Decision: once", "Noted."]);
    assert.deepEqual(
      turns.map((route) => [route.sender, route.text]),
      [
        [ALEX, "Run the tests"],
        [SAM, "1"],
      ],
    );
  },
);

test(
  "an unanswered question times out and a late reply is an ordinary message",
  { timeout: 8000 },
  async (t) => {
    const { runtime, turns, texts, finished } = await gateway(t, {
      // Far below the configurable range, to keep the test short.
      config: { permissionTimeoutS: 0.05 },
      turn: askingTurn,
    });
    runtime.acceptVerified(sms("ask", "Run the tests"));
    await finished("ask");
    assert.deepEqual(texts(), [QUESTION, "Decision: timeout"]);
    assert.equal(runtime.acceptVerified(sms("late", "1")), "accepted");
    assert.equal(runtime.eventState("evt-late"), "queued");
    await finished("late");
    assert.deepEqual(
      turns.map((route) => route.text),
      ["Run the tests", "1"],
    );
  },
);

test(
  "a question that cannot be delivered is declined",
  { timeout: 8000 },
  async (t) => {
    const { runtime, texts, finished } = await gateway(t, {
      turn: askingTurn,
      reply(_route, text) {
        if (text === QUESTION) throw new Error("send failed");
      },
    });
    runtime.acceptVerified(sms("ask", "Run the tests"));
    await finished("ask");
    assert.deepEqual(texts(), [QUESTION, "Decision: reject"]);
  },
);

test(
  "an agent task has nobody to ask: its questions are declined without a message",
  { timeout: 8000 },
  async (t) => {
    const task = {
      id: "task",
      contextId: "context",
      state: "working",
      caller: { identityId: "peer", handle: "peer" },
      target: { identityId: "agent-test" },
      messages: [
        { messageId: "m1", role: "caller", parts: [{ text: "Run the tests" }] },
      ],
    };
    const { runtime, sent, turns, unattended, finished } = await gateway(t, {
      identity: agent({}, { a2aTask: async () => task }),
      turn: askingTurn,
    });
    assert.equal(
      runtime.acceptVerified({
        id: "evt-task",
        event_type: "a2a.task.message",
        data: {
          task_id: "task",
          context_id: "context",
          message_id: "m1",
          caller: { identity_id: "peer", handle: "peer" },
          parts: [{ text: "Run the tests" }],
        },
      }),
      "accepted",
    );
    await finished("task");
    assert.deepEqual(sent, [
      {
        channel: "a2a",
        message: "m1",
        text: "Decision: reject",
        key: sent[0].key,
      },
    ]);
    assert.equal(turns.length, 1);
    // Pi is told nobody is there, so it starts without unasked tools.
    assert.deepEqual(unattended, [true]);
  },
);

test(
  "a Companion turn declines its questions without a message",
  { timeout: 8000 },
  async (t) => {
    const snapshot = {
      scopeId: "scope",
      activationId: "activation",
      conversationId: "group",
      channel: "phone",
      replyContext: { channel: "phone", conversationId: "group" },
      entries: [
        { id: "source", author: ALEX, isTrigger: true, historical: false },
      ],
      text: "Earlier conversation.",
    };
    const { runtime, turns, unattended, texts, finished } = await gateway(t, {
      identity: agent({ group: [ALEX, SAM] }),
      client: { companion: { loadInitialization: async () => snapshot } },
      turn: askingTurn,
    });
    const event = sms("source", "Run the tests", { conversation: "group" });
    event.data.text_message.sender_access = "direct";
    event.companion = {
      phase: "initialization",
      channel: "phone",
      sequence: 1,
      scope_id: "scope",
      conversation_id: "group",
      activation_id: "activation",
    };
    assert.equal(runtime.acceptVerified(event), "accepted");
    await finished("source");
    assert.deepEqual(texts(), ["Decision: reject"]);
    assert.equal(turns.length, 1);
    assert.match(turns[0].text, /Run the tests/);
    assert.deepEqual(unattended, [true]);
  },
);

test(
  "another participant cannot answer for a known contact, and that contact can",
  { timeout: 8000 },
  async (t) => {
    const { runtime, sent, turns, texts, finished } = await gateway(t, {
      identity: agent({ group: [ALEX, SAM] }),
      turn: askingTurn,
    });
    // Nothing in the event says this is a group: the job starts on the
    // contact's own session and is moved once the conversation is read back.
    const inGroup = {
      conversation: "group",
      contacts: [{ id: "contact-1", name: "Alex" }],
    };
    runtime.acceptVerified(sms("ask", "Run the tests", inGroup));
    await until(() => sent.length === 1, "the question");
    assert.equal(turns[0].group, true);
    assert.equal(turns[0].person, null);
    assert.equal(turns[0].thread, turns[0].conversationThread);

    runtime.acceptVerified(
      sms("sam", "1", { conversation: "group", from: SAM }),
    );
    assert.equal(runtime.eventState("evt-sam"), "queued");
    assert.equal(
      runtime.acceptVerified(sms("answer", "1", inGroup)),
      "accepted",
    );
    assert.equal(runtime.eventState("evt-answer"), "done");
    await finished("sam");
    assert.deepEqual(texts(), [QUESTION, "Decision: once", "Noted."]);
    assert.deepEqual(
      turns.map((route) => [route.sender, route.text]),
      [
        [ALEX, "Run the tests"],
        [SAM, "1"],
      ],
    );
  },
);

test(
  "where the agent must be mentioned, the question says so and a mentioned answer is taken",
  { timeout: 8000 },
  async (t) => {
    const { runtime, sent, turns, texts, finished } = await gateway(t, {
      identity: agent({ group: [ALEX, SAM] }),
      config: { groupReplyMode: "mention" },
      turn: askingTurn,
    });
    const inGroup = { conversation: "group" };
    runtime.acceptVerified(sms("ask", "@agent run the tests", inGroup));
    await until(() => sent.length === 1, "the question");
    assert.equal(
      sent[0].text,
      permissionPrompt(ACTION.summary, { mention: true }),
    );
    assert.equal(
      runtime.acceptVerified(sms("answer", "@agent allow", inGroup)),
      "accepted",
    );
    assert.equal(runtime.eventState("evt-answer"), "done");
    await finished("ask");
    assert.deepEqual(texts().slice(1), ["Decision: once"]);
    assert.equal(turns.length, 1);
  },
);

test(
  "one person is one session on every channel, but a question is answered where it was asked",
  { timeout: 8000 },
  async (t) => {
    const histories = [];
    const mail = {
      id: "mail",
      direction: "inbound",
      mailboxId: "box",
      threadId: "mail-thread",
      fromAddress: "alex@example.com",
      subject: "Re: tests",
      bodyText: "1",
      replyAllRecipients: { to: ["alex@example.com"], cc: [] },
    };
    const { runtime, sent, turns, finished } = await gateway(t, {
      identity: agent(
        { direct: [ALEX] },
        {
          mailbox: { id: "box", emailAddress: "agent@example.com" },
          getMessage: async () => mail,
        },
      ),
      async turn({ route, file, askPermission }) {
        histories.push(await remember(file, route.channel));
        if (route.channel === "sms")
          return "**Decision**: " + (await askPermission(ACTION));
        return "**Noted** by mail.";
      },
    });
    const contacts = [{ id: "contact-1", name: "Alex" }];

    runtime.acceptVerified(sms("text", "Run the tests", { contacts }));
    await until(() => sent.length === 1, "the question");
    assert.equal(sent[0].channel, "sms");

    // The same person from another address: neither an answer nor a decline.
    assert.equal(
      runtime.acceptVerified({
        id: "evt-mail",
        event_type: "message.received",
        data: {
          contacts: [
            {
              id: "contact-1",
              name: "Alex",
              bucket: "from",
              address: "alex@example.com",
            },
          ],
          message: {
            id: "mail",
            direction: "inbound",
            mailbox_id: "box",
            thread_id: "mail-thread",
            from_address: "alex@example.com",
            to_addresses: ["agent@example.com"],
            subject: "Re: tests",
            body: "1",
          },
        },
      }),
      "accepted",
    );
    assert.equal(runtime.eventState("evt-mail"), "queued");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(runtime.eventState("evt-text"), "running");
    assert.equal(sent.length, 1);

    assert.equal(
      runtime.acceptVerified(sms("answer", "1", { contacts })),
      "accepted",
    );
    assert.equal(runtime.eventState("evt-answer"), "done");
    await finished("mail");
    assert.deepEqual(
      sent.map((message) => [message.channel, message.text]),
      [
        ["sms", QUESTION],
        // Phone replies are plain text; mail keeps the model's formatting.
        ["sms", "Decision: once"],
        ["email", "**Noted** by mail."],
      ],
    );
    assert.deepEqual(
      turns.map((route) => [route.channel, route.message, route.person]),
      [
        ["sms", "text", "contact-1"],
        ["email", "mail", "contact-1"],
      ],
    );
    // The mail was an ordinary message, in the session the text started.
    assert.deepEqual(histories, ["", "sms;"]);
    assert.equal(turns[0].thread, digest("contact", "contact-1"));
    assert.equal(turns[1].thread, turns[0].thread);
    assert.notEqual(turns[1].conversationThread, turns[0].conversationThread);
  },
);

test(
  "a sender only the address book knows still gets their one session, and their commands act on it",
  { timeout: 8000 },
  async (t) => {
    const client = {
      contacts: {
        lookup: async (query) =>
          query.phone === ALEX ? [{ id: "contact-1", phones: [] }] : [],
      },
    };
    const histories = [];
    const { runtime, sent, turns, finished } = await gateway(t, {
      identity: agent({ direct: [ALEX], stranger: [SAM] }),
      client,
      async turn({ route, file }) {
        histories.push(await remember(file, route.message));
        return "Noted.";
      },
    });
    // This event names the contact; the next one, from the same number, does not.
    runtime.acceptVerified(
      sms("named", "One", { contacts: [{ id: "contact-1", name: "Alex" }] }),
    );
    await finished("named");
    runtime.acceptVerified(sms("unnamed", "Two"));
    await finished("unnamed");
    const session = digest("contact", "contact-1");
    assert.deepEqual(
      turns.map((route) => [route.person, route.thread]),
      [
        ["contact-1", session],
        ["contact-1", session],
      ],
    );
    assert.deepEqual(histories, ["", "named;"]);

    // A sender nobody knows keeps the conversation's own session.
    runtime.acceptVerified(
      sms("stranger", "Three", { conversation: "stranger", from: SAM }),
    );
    await finished("stranger");
    assert.equal(turns[2].person, null);
    assert.equal(turns[2].thread, turns[2].conversationThread);
    assert.equal(histories[2], "");

    // The unnamed sender's /clear resets the session their messages are in.
    runtime.acceptVerified(sms("reset", "/clear"));
    await finished("reset");
    assert.match(sent.at(-1).text, /^Conversation cleared\./);
    runtime.acceptVerified(sms("after", "Four"));
    await finished("after");
    assert.equal(histories[3], "");
  },
);

test(
  "the turn is told who is writing: the contact card and their memories",
  { timeout: 8000 },
  async (t) => {
    const lookups = [],
      framed = [];
    const client = {
      contacts: {
        async lookup(query) {
          lookups.push(query);
          return query.phone === ALEX
            ? [
                {
                  id: "contact-1",
                  preferredName: "Alex",
                  companyName: "Example Co",
                  emails: [{ value: "alex@example.com", isPrimary: true }],
                  phones: [{ value: ALEX }],
                },
              ]
            : [];
        },
      },
    };
    const { runtime, turns, finished } = await gateway(t, {
      identity: agent({ direct: [ALEX], stranger: [SAM] }),
      client,
      async turn({ route, file }) {
        await remember(file, route.message);
        framed.push(frameInbound(route));
        return "Hello.";
      },
    });
    const memories = ["Prefers short answers."];
    runtime.acceptVerified(
      sms("known", "Hi", {
        contacts: [{ id: "contact-1", name: "Alex E.", memories }],
      }),
    );
    await finished("known");
    const fromSam = { conversation: "stranger", from: SAM };
    runtime.acceptVerified(sms("unknown", "Who am I?", fromSam));
    await finished("unknown");
    runtime.acceptVerified(
      sms("event-only", "And now?", {
        ...fromSam,
        contacts: [{ id: "contact-2", name: "Sam" }],
      }),
    );
    await finished("event-only");

    assert.deepEqual(turns[0].contact, {
      id: "contact-1",
      name: "Alex",
      company: "Example Co",
      emails: ["alex@example.com"],
      phones: [ALEX],
    });
    assert.deepEqual(turns[0].memories, memories);
    assert.equal(turns[0].eventContact.name, "Alex E.");
    assert.match(
      framed[0].split("\n")[0],
      /^\[inkbox:sms from=\+12025550102 conversation_id=direct \| contact_id=contact-1 contact_name="Alex" /,
    );
    assert.ok(framed[0].includes('\n"Prefers short answers."\n'));
    assert.ok(framed[0].endsWith("\nHi"));

    assert.equal(turns[1].contact, null);
    assert.deepEqual(turns[1].memories, []);
    assert.equal(
      framed[1],
      "[inkbox:sms from=+12025550103 conversation_id=stranger | contact=unknown_in_inkbox]\nWho am I?",
    );

    // No address-book match: the contact the event resolved is used instead.
    assert.equal(turns[2].contact.id, "contact-2");
    assert.equal(turns[2].contact.name, "Sam");
    assert.match(framed[2], /\| contact_id=contact-2 contact_name="Sam"\]/);
    // The miss for that number was remembered rather than looked up again.
    assert.deepEqual(lookups, [{ phone: ALEX }, { phone: SAM }]);
  },
);

test(
  "contact memories can be turned off without losing the contact card",
  { timeout: 8000 },
  async (t) => {
    const { runtime, turns, finished } = await gateway(t, {
      config: { contactMemories: false },
      async turn({ route, file }) {
        await remember(file, route.message);
        return "Hello.";
      },
    });
    runtime.acceptVerified(
      sms("known", "Hi", {
        contacts: [{ id: "contact-1", name: "Alex", memories: ["A memory."] }],
      }),
    );
    await finished("known");
    assert.deepEqual(turns[0].memories, []);
    assert.equal(turns[0].contact.id, "contact-1");
    assert.equal(turns[0].person, "contact-1");
  },
);

test(
  "a text that turns out to be a group message leaves the sender's own session",
  { timeout: 8000 },
  async (t) => {
    const histories = [];
    const { runtime, sent, turns, finished } = await gateway(t, {
      identity: agent({ direct: [ALEX], group: [ALEX, SAM] }),
      async turn({ route, file }) {
        histories.push([
          route.conversation,
          await remember(file, route.conversation),
        ]);
        return "Hello.";
      },
    });
    const contacts = [
      { id: "contact-1", name: "Alex", memories: ["A private memory."] },
    ];
    runtime.acceptVerified(sms("one", "Just us", { contacts }));
    await finished("one");
    // Nothing in the event says this conversation has other members.
    runtime.acceptVerified(
      sms("two", "Hi all", { contacts, conversation: "group" }),
    );
    await finished("two");
    runtime.acceptVerified(sms("three", "Just us again", { contacts }));
    await finished("three");

    assert.deepEqual(histories, [
      ["direct", ""],
      ["group", ""],
      ["direct", "direct;"],
    ]);
    const [direct, group, later] = turns;
    assert.equal(direct.thread, digest("contact", "contact-1"));
    assert.equal(later.thread, direct.thread);
    assert.deepEqual(direct.memories, ["A private memory."]);
    assert.equal(group.group, true);
    assert.equal(group.person, null);
    assert.deepEqual(group.memories, []);
    // The event's contact is not attributed to a group member either.
    assert.equal(group.contact, null);
    assert.equal(group.thread, group.conversationThread);
    assert.notEqual(group.thread, direct.thread);
    assert.equal(sent.length, 3);
  },
);
