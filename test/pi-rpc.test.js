import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  createTurnRpc,
  permissionRequest,
  PERMISSION_TITLE,
} from "../gateway/pi-rpc.js";

// Stands in for the Pi child's stdin and records each JSONL record written.
function pipe() {
  const records = [];
  return {
    records,
    writable: true,
    writableEnded: false,
    write(line) {
      assert.ok(line.endsWith("\n") && line.indexOf("\n") === line.length - 1);
      records.push(JSON.parse(line));
    },
    end() {
      this.writableEnded = true;
    },
  };
}

function turn(askPermission, stdin = pipe()) {
  const owner = new AbortController();
  const rpc = createTurnRpc(stdin, owner.signal, askPermission);
  return { rpc, stdin, records: stdin.records, owner };
}

const dialog = (fields) => ({
  type: "extension_ui_request",
  id: "dialog",
  method: "input",
  title: PERMISSION_TITLE,
  placeholder: permissionRequest("bash", "run the command: ls"),
  ...fields,
});

const started = (id, fields) => ({
  type: "response",
  id,
  command: "prompt",
  success: true,
  data: { disposition: "started" },
  ...fields,
});

test("a turn starts with one prompt and ends once Pi accepted it and settled", () => {
  const { rpc, stdin, records } = turn();
  rpc.start("[inkbox:sms from=+12025550102]\nhello");
  assert.equal(records.length, 1);
  const [prompt] = records;
  assert.equal(prompt.type, "prompt");
  assert.equal(prompt.message, "[inkbox:sms from=+12025550102]\nhello");
  assert.equal(typeof prompt.id, "string");
  assert.equal(rpc.started(), false);
  assert.equal(rpc.completed(), false);

  // Another command's response and ordinary session events change nothing.
  rpc.handle(started("another-command"));
  rpc.handle({ type: "agent_end" });
  assert.equal(rpc.started(), false);
  assert.equal(rpc.completed(), false);

  rpc.handle(started(prompt.id));
  assert.equal(rpc.started(), true);
  assert.equal(rpc.completed(), false);
  assert.equal(stdin.writableEnded, false);
  rpc.handle({ type: "agent_settled" });
  assert.equal(rpc.completed(), true);
  assert.equal(stdin.writableEnded, true);
  assert.equal(records.length, 1);
});

test("settling before the prompt response still waits for Pi to accept the prompt", () => {
  const { rpc, stdin, records } = turn();
  rpc.start("hello");
  rpc.handle({ type: "agent_settled" });
  assert.equal(rpc.started(), false);
  assert.equal(rpc.completed(), false);
  assert.equal(stdin.writableEnded, false);
  rpc.handle(started(records[0].id));
  assert.equal(rpc.completed(), true);
  assert.equal(stdin.writableEnded, true);
});

test("a prompt that Pi did not start as a run fails the turn with Pi's reason", () => {
  for (const [fields, piError] of [
    [{ success: false, error: "No API key found" }, "No API key found"],
    [{ success: false, error: { code: 7 } }, ""],
    [{ success: false }, ""],
    [{ data: { disposition: "handled" } }, ""],
    [{ data: { disposition: "queued" } }, ""],
    [{ data: undefined }, ""],
  ]) {
    const { rpc, stdin, records } = turn();
    rpc.start("hello");
    assert.throws(
      () => rpc.handle(started(records[0].id, fields)),
      (error) =>
        /did not start/.test(error.message) && error.piError === piError,
    );
    rpc.handle({ type: "agent_settled" });
    assert.equal(rpc.started(), false);
    assert.equal(rpc.completed(), false);
    assert.equal(stdin.writableEnded, false);
  }
});

test("the permission dialog is relayed and its decision becomes allow, deny or timeout", async () => {
  for (const [decision, value] of [
    ["once", "allow"],
    ["always", "allow"],
    ["reject", "deny"],
    ["timeout", "timeout"],
    [undefined, "deny"],
    ["allow", "deny"],
  ]) {
    const asked = [];
    const { rpc, records, owner } = turn(async (request, signal) => {
      asked.push([request, signal]);
      return decision;
    });
    rpc.handle(dialog({ id: "question-" + decision }));
    await setImmediate();
    assert.deepEqual(asked, [
      [{ key: "bash", summary: "run the command: ls" }, owner.signal],
    ]);
    assert.deepEqual(records, [
      {
        type: "extension_ui_response",
        id: "question-" + decision,
        value,
      },
    ]);
  }
});

test("a relay failure cancels the question instead of approving it", async () => {
  const { rpc, records } = turn(async () => {
    throw new Error("The conversation is unreachable.");
  });
  rpc.handle(dialog());
  await setImmediate();
  assert.deepEqual(records, [
    { type: "extension_ui_response", id: "dialog", cancelled: true },
  ]);
});

test("malformed permission requests and every other dialog are cancelled unasked", async () => {
  const asked = [];
  const { rpc, records } = turn(async (request) => {
    asked.push(request);
    return "always";
  });
  const requests = [
    dialog({ placeholder: "run the command: ls" }),
    dialog({ placeholder: undefined }),
    dialog({ placeholder: "null" }),
    dialog({ placeholder: JSON.stringify(["bash", "run"]) }),
    dialog({ placeholder: JSON.stringify({ summary: "run" }) }),
    dialog({ placeholder: JSON.stringify({ key: "", summary: "run" }) }),
    dialog({ placeholder: JSON.stringify({ key: 7, summary: "run" }) }),
    dialog({ placeholder: JSON.stringify({ key: "bash" }) }),
    dialog({ placeholder: JSON.stringify({ key: "bash", summary: 7 }) }),
    dialog({ placeholder: permissionRequest("bash", " \u0000\t\u202e ") }),
    dialog({ title: "Another extension" }),
    dialog({ title: PERMISSION_TITLE + " " }),
    dialog({ method: "confirm", message: "Allow?" }),
    dialog({ method: "select", options: ["allow", "deny"] }),
    dialog({ method: "editor", prefill: "allow" }),
  ];
  requests.forEach((request, index) =>
    rpc.handle({ ...request, id: "dialog-" + index }),
  );
  await setImmediate();
  assert.deepEqual(asked, []);
  assert.deepEqual(
    records,
    requests.map((_, index) => ({
      type: "extension_ui_response",
      id: "dialog-" + index,
      cancelled: true,
    })),
  );

  // Notifications expect no response, and a dialog without an ID cannot get one.
  rpc.handle(dialog({ method: "notify", message: "Working" }));
  rpc.handle(dialog({ method: "setStatus", statusKey: "k", statusText: "v" }));
  rpc.handle(dialog({ id: undefined }));
  rpc.handle(dialog({ id: 7 }));
  await setImmediate();
  assert.deepEqual(asked, []);
  assert.equal(records.length, requests.length);
});

test("without a relay the permission dialog is cancelled", async () => {
  const { rpc, records } = turn(undefined);
  rpc.handle(dialog());
  await setImmediate();
  assert.deepEqual(records, [
    { type: "extension_ui_response", id: "dialog", cancelled: true },
  ]);
});

test("the relayed summary keeps line breaks, drops control characters and says what it hides", async () => {
  const asked = [];
  const { rpc, records } = turn(async (request) => {
    asked.push(request);
    return "once";
  });
  const send = async (key, summary) => {
    rpc.handle(dialog({ placeholder: permissionRequest(key, summary) }));
    await setImmediate();
    return asked.at(-1);
  };

  const cleaned = await send(
    "bash",
    "\u0007run\u0000 the\u202e command\r\nnext\tline\u2066\u200b\u007f",
  );
  assert.equal(cleaned.summary, "run  the  command \nnext line");
  assert.doesNotMatch(
    cleaned.summary,
    /[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/,
  );

  const long = await send("k".repeat(600), "x".repeat(1300));
  assert.equal(long.key, "k".repeat(500));
  assert.equal(
    long.summary,
    "x".repeat(1200) + "\u2026 [100 more characters not shown]",
  );

  const exact = await send("write", "y".repeat(1200));
  assert.equal(exact.summary, "y".repeat(1200));

  assert.equal(asked.length, 3);
  assert.ok(records.every((record) => record.value === "allow"));
});

test("nothing is written to Pi after the turn is aborted", async () => {
  const waiting = Promise.withResolvers();
  const asked = [];
  const { rpc, records, owner } = turn((request) => {
    asked.push(request);
    return waiting.promise;
  });
  rpc.start("hello");
  rpc.handle(dialog({ id: "open" }));
  await setImmediate();
  assert.equal(asked.length, 1);
  assert.equal(records.length, 1);

  owner.abort();
  waiting.resolve("always");
  await setImmediate();
  rpc.handle(dialog({ id: "late" }));
  rpc.handle(dialog({ id: "late-confirm", method: "confirm" }));
  rpc.start("again");
  await setImmediate();
  assert.equal(asked.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].type, "prompt");
});

test("nothing is written once Pi's input has closed", async () => {
  const stdin = pipe();
  const { rpc, records } = turn(async () => "once", stdin);
  rpc.start("hello");
  rpc.handle(started(records[0].id));
  rpc.handle({ type: "agent_settled" });
  assert.equal(stdin.writableEnded, true);
  rpc.handle(dialog());
  await setImmediate();
  assert.equal(records.length, 1);

  const closed = Object.assign(pipe(), { writable: false });
  turn(undefined, closed).rpc.start("hello");
  assert.deepEqual(closed.records, []);
});
