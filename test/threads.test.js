import assert from "node:assert/strict";
import test from "node:test";
import {
  mailControl,
  phoneSubthread,
  samePhoneThread,
} from "../gateway/threads.js";

const quoted = [
  "On Mon, 5 Jan 2026 at 10:00, Agent <agent@example.com> wrote:",
  "> Permission needed: run the command: npm test",
  ">",
  "> /clear",
].join("\n");

test("an ordinary mail body is kept whole, quoted history included", () => {
  for (const body of [
    "Hello,\n\nplease stop the build when you can.",
    "Thanks!\n\n" + quoted,
    "> /stop\nI did not write that line.",
    "/stopping by later today\n" + quoted,
    "Yes, but only the first file.\n" + quoted,
  ])
    assert.equal(mailControl(body), body);
  assert.equal(mailControl("  \n Hello \r\n"), "Hello");
  for (const missing of [undefined, null, 7, {}])
    assert.equal(mailControl(missing), "");
});

test("a leading command drops the quoted history, signature or forwarded header after it", () => {
  for (const command of ["/stop", "/cancel", "/clear", "/new", "/status"]) {
    assert.equal(mailControl(command + "\n\n" + quoted), command);
    assert.equal(mailControl(command.toUpperCase()), command.toUpperCase());
  }
  assert.equal(
    mailControl("\r\n  /stop\r\n\r\n> earlier\r\n> /clear\r\n"),
    "/stop",
  );
  assert.equal(mailControl("/status\n-- \nSent from my phone"), "/status");
  assert.equal(
    mailControl(
      "/new\n\n-----Original Message-----\nFrom: Agent <agent@example.com>\nSubject: Re: build",
    ),
    "/new",
  );
});

test("a leading approval answer drops the quoted question after it", () => {
  for (const answer of ["1", "2", "3", "Yes", "always allow", "No."])
    assert.equal(mailControl(answer + "\n\n" + quoted), answer);
  assert.equal(mailControl("1\n> Permission needed: run the command: ls"), "1");
});

test("text the author wrote after a command is never discarded", () => {
  assert.equal(
    mailControl("/stop\nand then email me the logs"),
    "/stop\nand then email me the logs",
  );
  const interleaved = "/stop\n> you asked\nbut keep the report";
  assert.equal(mailControl(interleaved), interleaved);
});

test("a phone message that only roots its own thread is not in a subthread", () => {
  assert.equal(phoneSubthread("message", "message", undefined), "");
  assert.equal(phoneSubthread("message", "", undefined), "");
  assert.equal(phoneSubthread("message", undefined, undefined), "");
  assert.equal(phoneSubthread("message", "root", undefined), "root");
  assert.equal(phoneSubthread("message", "root", "parent"), "root");
  // A reply to itself as root still names a parent, so it is a thread.
  assert.equal(phoneSubthread("message", "message", "parent"), "message");
});

test("a source read back from the API must be in the thread the event named", () => {
  const top = { subthread: "" };
  const reply = { subthread: "root" };
  assert.equal(samePhoneThread(top, { id: "message" }), true);
  assert.equal(samePhoneThread({}, { id: "message" }), true);
  // Quoting a top-level message later makes it the root of its own thread.
  assert.equal(
    samePhoneThread(top, { id: "message", threadRootMessageId: "message" }),
    true,
  );
  assert.equal(
    samePhoneThread(reply, {
      id: "message",
      threadRootMessageId: "root",
      replyToMessageId: "root",
    }),
    true,
  );
  assert.equal(
    samePhoneThread(reply, { id: "message", threadId: "root" }),
    true,
  );
  for (const source of [
    { id: "message" },
    { id: "message", threadRootMessageId: "another" },
    { id: "message", threadRootMessageId: "message" },
  ])
    assert.equal(samePhoneThread(reply, source), false);
  assert.equal(
    samePhoneThread(top, { id: "message", threadRootMessageId: "root" }),
    false,
  );
});
