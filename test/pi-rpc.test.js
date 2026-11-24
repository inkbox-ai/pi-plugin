import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  createEditRpc,
  encodeEditProposal,
  PROJECT_EDIT_TITLE,
} from "../gateway/pi-rpc.js";

test("approval renders a complete inert JSON change or fails instead of truncating", () => {
  const proposal = {
    file: "notes.md",
    oldText: "a\n\u007f\u202e🙂",
    newText: '*_~<x>\r"\\',
  };
  const encoded = encodeEditProposal(proposal);
  assert.doesNotMatch(encoded, /[^\x20-\x7e]|[*_~<>]/);
  assert.deepEqual(JSON.parse(encoded), proposal);
  assert.throws(() =>
    encodeEditProposal({ ...proposal, oldText: "\u202e".repeat(201) }),
  );
  assert.throws(() => encodeEditProposal({ ...proposal, newText: "\ud800" }));
});

test("only canonical, granted, exact Pi dialogs can authorize one replacement; abort ignores late replies", async () => {
  const records = [];
  const stdin = {
    writable: true,
    writableEnded: false,
    write(record) {
      records.push(JSON.parse(record));
    },
    end() {
      this.writableEnded = true;
    },
  };
  const change = { file: "notes.md", oldText: "x", newText: "y" };
  const visit = [];
  const wait = Promise.withResolvers();
  const owner = new AbortController();
  const rpc = createEditRpc(
    stdin,
    ["notes.md"],
    (p, sig) => {
      visit.push(p);
      assert.equal(sig, owner.signal);
      return wait.promise;
    },
    owner.signal,
  );
  const request = {
    type: "extension_ui_request",
    id: "dialog",
    method: "confirm",
    title: PROJECT_EDIT_TITLE,
    message: encodeEditProposal(change),
  };
  rpc.handle({ ...request, title: "Other extension" });
  rpc.handle({ ...request, message: " " + request.message });
  rpc.handle({
    ...request,
    message: encodeEditProposal({ ...change, file: "other.md" }),
  });
  assert.equal(visit.length, 0);
  assert.ok(records.every((r) => r.confirmed !== true));
  rpc.handle(request);
  rpc.handle({ ...request, id: "concurrent" });
  assert.deepEqual(visit, [change]);
  assert.equal(records.at(-1).cancelled, true);
  const before = records.length;
  owner.abort();
  wait.resolve(true);
  await setImmediate();
  assert.equal(records.length, before);
});
