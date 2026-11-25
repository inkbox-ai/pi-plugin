import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  createPermissions,
  parsePermissionReply,
  permissionPrompt,
} from "../gateway/permissions.js";

const ALEX = "+12025550102";
const SAM = "+12025550103";
const SUMMARY = "run the command: npm test";

test("short replies are read as allow once, always allow or decline; anything else is not an answer", () => {
  const table = {
    once: [
      "1",
      "y",
      "Yes",
      " yes ",
      "YES!",
      "ok",
      "Okay.",
      "approve",
      "allow",
      "sure",
      "go",
      "Go  ahead",
      "Yes please go ahead",
    ],
    always: ["2", "always", "Always allow", "allow always", "Yes always."],
    reject: [
      "3",
      "n",
      "No",
      "no.",
      "deny",
      "decline",
      "stop",
      "block",
      "don't",
      "Dont",
      "reject",
      "cancel",
    ],
  };
  for (const [decision, replies] of Object.entries(table))
    for (const reply of replies)
      assert.equal(parsePermissionReply(reply), decision, reply);
  for (const other of [
    "",
    "   ",
    "4",
    "12",
    "maybe",
    "yes but only the first file",
    "what does that command do?",
    "/stop",
    "@agent allow",
    "1".padStart(65),
    undefined,
    null,
    1,
    ["1"],
  ])
    assert.equal(parsePermissionReply(other), null, String(other));
});

test("the question names the action and the three ways to answer", () => {
  const prompt = permissionPrompt(SUMMARY);
  assert.ok(prompt.startsWith("Permission needed: " + SUMMARY + "\n"));
  const options = prompt.slice(prompt.lastIndexOf("\n") + 1);
  assert.match(options, /1 to allow once/);
  assert.match(options, /2 to always allow/);
  assert.match(options, /3 to decline/);
  assert.doesNotMatch(prompt, /@agent/);
  assert.equal(permissionPrompt(SUMMARY, { mention: false }), prompt);
  // Where only messages that mention the agent arrive, the question says so.
  const mentioned = permissionPrompt(SUMMARY, { mention: true });
  assert.ok(mentioned.startsWith(prompt));
  assert.match(mentioned.slice(prompt.length), /@agent allow/);
});

// One question in one conversation. `delivered` settles once the call that
// sent the prompt has returned, which is when an answer starts to count.
function question(permissions, overrides = {}) {
  const prompted = Promise.withResolvers();
  const controller = new AbortController();
  const prompts = [];
  const result = permissions.ask({
    conversation: "conversation",
    session: "session",
    actor: ALEX,
    key: "bash",
    summary: SUMMARY,
    signal: controller.signal,
    timeoutMs: 60_000,
    async send(prompt) {
      prompts.push(prompt);
      prompted.resolve(prompt);
    },
    ...overrides,
  });
  const delivered = prompted.promise.then(async (prompt) => {
    await nextTurn();
    return prompt;
  });
  return { result, delivered, prompts, controller };
}

test("the asker's reply settles the question once", async () => {
  for (const [reply, decision] of [
    ["1", "once"],
    ["Always allow", "always"],
    ["no", "reject"],
  ]) {
    const permissions = createPermissions();
    const asked = question(permissions);
    assert.equal(await asked.delivered, permissionPrompt(SUMMARY));
    assert.equal(permissions.answer("conversation", ALEX, reply), "answered");
    assert.equal(await asked.result, decision);
    // The question is closed: a second reply is ordinary conversation.
    assert.equal(permissions.answer("conversation", ALEX, "1"), null);
    assert.equal(asked.prompts.length, 1);
  }
});

test("a question asked where the agent must be mentioned says so", async () => {
  const permissions = createPermissions();
  const asked = question(permissions, { mention: true });
  assert.equal(
    await asked.delivered,
    permissionPrompt(SUMMARY, { mention: true }),
  );
  assert.equal(permissions.answer("conversation", ALEX, "allow"), "answered");
  assert.equal(await asked.result, "once");
});

test("always allow covers that person, action and session until the session is cleared", async () => {
  const permissions = createPermissions();
  const first = question(permissions);
  await first.delivered;
  permissions.answer("conversation", ALEX, "2");
  assert.equal(await first.result, "always");

  // The same person, action and session: no question, wherever it is asked.
  for (const overrides of [{}, { conversation: "other-conversation" }]) {
    const repeat = question(permissions, overrides);
    assert.equal(await repeat.result, "once");
    assert.deepEqual(repeat.prompts, []);
  }

  for (const overrides of [
    { key: "write" },
    { actor: SAM },
    { session: "other-session" },
  ]) {
    const asked = question(permissions, overrides);
    await asked.delivered;
    assert.equal(asked.prompts.length, 1);
    assert.equal(
      permissions.answer("conversation", overrides.actor ?? ALEX, "3"),
      "answered",
    );
    assert.equal(await asked.result, "reject");
  }

  permissions.clear("other-session");
  assert.equal(await question(permissions).result, "once");
  permissions.clear("session");
  const afterReset = question(permissions);
  await afterReset.delivered;
  permissions.answer("conversation", ALEX, "1");
  assert.equal(await afterReset.result, "once");
  // Allowing once is never remembered.
  const again = question(permissions);
  await again.delivered;
  permissions.answer("conversation", ALEX, "3");
  assert.equal(await again.result, "reject");
});

test("a message that is not an answer declines the question", async () => {
  const permissions = createPermissions();
  const asked = question(permissions);
  await asked.delivered;
  assert.equal(
    permissions.answer("conversation", ALEX, "wait, what does that do?"),
    "declined",
  );
  assert.equal(await asked.result, "reject");
  assert.equal(permissions.answer("conversation", ALEX, "1"), null);
});

test("only the address that was asked, in the conversation it was asked in, can answer", async () => {
  const permissions = createPermissions();
  assert.equal(permissions.answer("conversation", ALEX, "1"), null);
  const asked = question(permissions);
  await asked.delivered;
  assert.equal(permissions.answer("conversation", SAM, "1"), null);
  assert.equal(permissions.answer("conversation", SAM, "never mind"), null);
  assert.equal(permissions.answer("other-conversation", ALEX, "1"), null);
  assert.equal(permissions.answer("session", ALEX, "1"), null);
  // None of those closed the question.
  assert.equal(permissions.answer("conversation", ALEX, "1"), "answered");
  assert.equal(await asked.result, "once");
});

test("a reply sent before the question was delivered is not an answer to it", async () => {
  const permissions = createPermissions();
  const sending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const asked = question(permissions, {
    send() {
      started.resolve();
      return sending.promise;
    },
  });
  await started.promise;
  await nextTurn();
  // Neither an answer nor a decline: the person has not seen the question.
  assert.equal(permissions.answer("conversation", ALEX, "1"), null);
  assert.equal(permissions.answer("conversation", ALEX, "hello"), null);
  sending.resolve({ id: "sent" });
  await nextTurn();
  assert.equal(permissions.answer("conversation", ALEX, "2"), "answered");
  assert.equal(await asked.result, "always");
});

test("an unanswered question times out", async () => {
  const permissions = createPermissions();
  const asked = question(permissions, { timeoutMs: 20 });
  await asked.delivered;
  assert.equal(await asked.result, "timeout");
  assert.equal(permissions.answer("conversation", ALEX, "1"), null);
});

test("a stopped turn rejects its question, before or after it was sent", async () => {
  const permissions = createPermissions();
  const asked = question(permissions);
  await asked.delivered;
  asked.controller.abort();
  assert.equal(await asked.result, "reject");
  assert.equal(permissions.answer("conversation", ALEX, "1"), null);

  const stopped = new AbortController();
  stopped.abort();
  const never = question(permissions, { signal: stopped.signal });
  assert.equal(await never.result, "reject");
  assert.deepEqual(never.prompts, []);
});

test("a question that could not be delivered is rejected", async () => {
  const permissions = createPermissions();
  for (const send of [
    async () => {
      throw new Error("send failed");
    },
    () => {
      throw new Error("send failed synchronously");
    },
    async () => ({ skipped: true }),
  ]) {
    assert.equal(await question(permissions, { send }).result, "reject");
    assert.equal(permissions.answer("conversation", ALEX, "1"), null);
  }
  // A delivered question still works afterwards.
  const asked = question(permissions);
  await asked.delivered;
  permissions.answer("conversation", ALEX, "1");
  assert.equal(await asked.result, "once");
});

test("questions in one conversation are asked one at a time", async () => {
  const permissions = createPermissions();
  const first = question(permissions);
  const second = question(permissions, {
    key: "write",
    summary: "create or overwrite the file notes.md",
  });
  const third = question(permissions);
  const elsewhere = question(permissions, {
    conversation: "other-conversation",
    session: "other-session",
  });
  await first.delivered;
  await elsewhere.delivered;
  assert.deepEqual(second.prompts, []);
  assert.deepEqual(third.prompts, []);

  permissions.answer("conversation", ALEX, "2");
  assert.equal(await first.result, "always");
  assert.match(await second.delivered, /notes\.md/);
  assert.equal(permissions.answer("conversation", ALEX, "3"), "answered");
  assert.equal(await second.result, "reject");
  // The first answer already covers the same action queued behind it.
  assert.equal(await third.result, "once");
  assert.deepEqual(third.prompts, []);

  elsewhere.controller.abort();
  assert.equal(await elsewhere.result, "reject");
});
