import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, unlink, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseA2AOutcome } from "../extension/a2a-outcome.js";
import { approveOutbound } from "../extension/permissions.ts";
import { sendEmailTools } from "../extension/tools/send-email.ts";
import { slackTools } from "../extension/tools/slack.ts";
import { whatsappTools } from "../extension/tools/whatsapp.ts";
import { requestKey } from "../extension/message-key.ts";

const ask = { slackEnabled: true, outbound: { approval: "ask", allowedRecipients: [] } };
const ctx = { callId: "tool:1", sessionID: "session:1", confirm: async () => true };

test("A2A can request input, fail or complete, but a model cannot retarget a task", () => {
  for (const intent of ["ask_caller", "fail", "complete"]) {
    const outcome = { intent, text: "A response" };
    assert.deepEqual(parseA2AOutcome(JSON.stringify(outcome)), outcome);
  }
  assert.deepEqual(parseA2AOutcome("done"), { intent: "complete", text: "done" });
  assert.throws(() => parseA2AOutcome(JSON.stringify({ intent: "fail", text: "failed", taskId: "another" })));
  assert.throws(() => parseA2AOutcome(JSON.stringify({ intent: "progress", text: "not final" })));
});

test("an A2A URL allowlist cannot authorize a different case-sensitive path", async () => {
  const config = { outbound: { approval: "allowlist", allowedRecipients: ["https://example.test/Card"] } };
  const request = { tool: "inkbox_a2a_call", recipients: ["https://example.test/card"], summary: "Task" };
  await assert.rejects(() => approveOutbound(ctx, config, request), /allowlist/);
});

test("a confirmation names the destinations an always-allow answer would cover", async () => {
  const calls = [];
  const asking = { ...ctx, confirm: async (...args) => { calls.push(args); return true; } };
  await approveOutbound(asking, ask, { tool: "inkbox_send_sms", recipients: ["+12025550101", "+12025550102"], summary: "Send text" });
  await approveOutbound(asking, ask, { tool: "inkbox_remote_call", recipients: [], patterns: ["inkbox_contact_create"], summary: "Run operation" });
  assert.deepEqual(calls.map(([title, , patterns]) => [title, patterns]), [
    ["inkbox_send_sms", ["+12025550101", "+12025550102"]],
    ["inkbox_remote_call", ["inkbox_contact_create"]],
  ]);
  assert.match(calls[0][1], /Send text/);
  // With nothing to name there is nothing to approve.
  await assert.rejects(() => approveOutbound(asking, ask, { tool: "inkbox_send_sms", recipients: [], summary: "Send text" }), /not approved/);
  assert.equal(calls.length, 2);
});

test("sendEmail reads attachments from the Pi session directory and retains a stable request key", async t => {
  const directory = await mkdtemp(join(tmpdir(), "inkbox-pi-email-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "notes.txt"), "hello");
  const requests = [];
  const identity = { sendEmail: async args => { requests.push(args); return { id: "mail" }; } };
  const [tool] = sendEmailTools({ runtime: { getIdentity: async () => identity }, config: ask });
  const args = { to: ["user@example.test"], subject: "Attached", attachmentPaths: ["notes.txt"] };
  await tool.definition.execute(args, { ...ctx, directory });
  await tool.definition.execute(args, { ...ctx, directory });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].idempotencyKey, requestKey(ctx));
  assert.notEqual(requests[0].idempotencyKey, requestKey({ ...ctx, sessionID: "other" }));
  assert.equal(requests[0].attachments[0].contentBase64, Buffer.from("hello").toString("base64"));
});

test("Slack uploads freeze the selected file and enforce the actual SDK byte limit", async t => {
  const directory = await mkdtemp(join(tmpdir(), "inkbox-pi-slack-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = join(directory, "notes.txt");
  await writeFile(join(directory, "first.txt"), "expected");
  await writeFile(join(directory, "second.txt"), "not selected");
  await symlink("first.txt", link);
  let sent;
  const client = { slack: {
    listConnections: async () => ({ connections: [{ id: "slack-id", identityId: "owner", status: "connected" }] }),
    uploadFile: async (_id, args) => { sent = args; return { id: "upload" }; },
  } };
  const tool = slackTools({ runtime: { getIdentity: async () => ({ id: "owner" }), getClient: async () => client }, config: ask })
    .find(t => t.name === "inkbox_slack_upload_file");
  const args = { connectionId: "slack-id", conversationId: "channel", filePath: "notes.txt", idempotencyKey: "op-1" };
  await tool.definition.execute(args, { ...ctx, directory, confirm: async () => {
    await unlink(link);
    await symlink("second.txt", link);
    return true;
  } });
  assert.equal(Buffer.from(sent.contentBase64, "base64").toString(), "expected");
  await truncate(join(directory, "second.txt"), 10 * 1024 * 1024 + 1);
  await assert.rejects(() => tool.definition.execute(args, { ...ctx, directory }), /exceeds/);
});

test("WhatsApp checks every group member before and after approval", async () => {
  const first = "+12025550101", second = "+12025550102";
  let members = [first, second], sends = 0;
  const identity = { id: "identity", getWhatsAppConversation: async id => ({
    id, agentIdentityId: "identity", participants: [...members], isGroup: true,
    unresolvedParticipantCount: 0, remoteNumber: null, localNumber: null,
  }), sendWhatsApp: async () => { sends++; return { id: "done" }; } };
  const tool = whatsappTools({ runtime: { getIdentity: async () => identity }, config: {
    outbound: { approval: "ask", allowedRecipients: [first, second] },
  } }).find(t => t.name === "inkbox_send_whatsapp");
  const args = { conversationId: "group", text: "hello" };
  await tool.definition.execute(args, ctx);
  assert.equal(sends, 1);
  await assert.rejects(() => tool.definition.execute(args, { ...ctx, confirm: async () => {
    members = [first, "+12025550103"]; return true;
  } }), /changed/);
  await assert.rejects(() => tool.definition.execute(args, ctx), /allowlist/);
  assert.equal(sends, 1);
});

test("A2A task follow-ups keep the original task and report the recovery ID on uncertainty", async () => {
  const { a2aTools } = await import("../extension/tools/a2a.ts");
  let recorded;
  const a2a = {
    fetchCard: async () => ({ rpcUrl: "https://example.test/rpc" }),
    send: async (_target, args) => { recorded = args; throw new Error("Timed out"); },
  };
  const tool = a2aTools({ runtime: { getIdentity: async () => ({ a2aClient: () => a2a }) }, config: ask })
    .find(t => t.name === "inkbox_a2a_reply");
  await assert.rejects(() => tool.definition.execute({
    cardUrl: "https://example.test/card", text: "details", taskId: "current",
  }, ctx), new RegExp(requestKey(ctx)));
  assert.equal(recorded.taskId, "current");
  assert.equal(recorded.messageId, requestKey(ctx));
});

test("WhatsApp reactions check the owned target and its current audience", async () => {
  const allowed = "+12025550101", other = "+12025550102";
  let current = [allowed], owner = "self", writes = 0;
  const identity = { id:"self",
    getWhatsAppReaction: async id => ({id,agentIdentityId:owner,conversationId:"chat",targetMessageId:"message"}),
    getWhatsAppMessage: async id => ({id,agentIdentityId:owner,conversationId:"chat"}),
    getWhatsAppConversation: async id => ({id,agentIdentityId:"self",unresolvedParticipantCount:0,isGroup:true,
      remoteNumber:null,participants:[...current]}),
    sendWhatsAppReaction:async () => ++writes, removeWhatsAppReaction:async () => ++writes,
  };
  const tools = whatsappTools({runtime:{getIdentity:async () => identity},config:{outbound:{approval:"ask",allowedRecipients:[allowed]}}});
  for (const remove of [false,true]) {
    const tool = tools.find(t => t.name === (remove ? "inkbox_remove_whatsapp_reaction" : "inkbox_send_whatsapp_reaction"));
    const args = remove ? {reactionId:"reaction",idempotencyKey:"remove"} : {messageId:"message",reaction:"love",idempotencyKey:"send"};
    current = [allowed]; owner = "self";
    await tool.definition.execute(args,ctx);
    await assert.rejects(tool.definition.execute(args,{...ctx, confirm:async () => {current = [allowed,other]; return true;}}),/changed/);
    await assert.rejects(tool.definition.execute(args,ctx),/allowlist/);
    owner = "other";
    await assert.rejects(tool.definition.execute(args,ctx),/belong/);
  }
  assert.equal(writes,2);
});
