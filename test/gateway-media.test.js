import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createGatewayRuntime } from "../gateway/runtime.js";
import { parseRoute, beforeTurn } from "../gateway/channels.js";
import { attachments, refreshMedia, describeMedia } from "../gateway/media.js";

const identity = {
  id: "agent",
  agentHandle: "test",
  phoneNumber: { number: "+12025550101" },
  async listTextConversations() {
    return [
      {
        id: "conversation",
        isGroup: false,
        remotePhoneNumber: "+12025550102",
        participants: ["+12025550102"],
      },
    ];
  },
};
const original = () => ({
  id: "original",
  event_type: "text.received",
  data: {
    text_message: {
      id: "msg",
      direction: "inbound",
      local_phone_number: identity.phoneNumber.number,
      sender_phone_number: "+12025550102",
      conversation_id: "conversation",
      text: "A caption",
      media: [
        {
          id: "clip",
          content_type: "audio/ogg",
          size: 123,
          url: "https://example.invalid/private-asset",
          transcription: { status: "pending", text: null },
        },
      ],
    },
  },
});

test(
  "pending speech wakes the original source exactly once, using SDK text rather than callback bytes",
  { timeout: 7000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "pi-media-"));
    const polled = Promise.withResolvers(),
      sent = Promise.withResolvers(),
      seen = [];
    let ready = false;
    const gateway = createGatewayRuntime(
      { home },
      {
        identity: {
          ...identity,
          async getText() {
            polled.resolve();
            return {
              id: "msg",
              conversationId: "conversation",
              direction: "inbound",
              localPhoneNumber: identity.phoneNumber.number,
              senderPhoneNumber: "+12025550102",
              media: [
                {
                  id: "clip",
                  contentType: "audio/ogg",
                  size: 123,
                  transcription: {
                    status: ready ? "completed" : "pending",
                    text: ready ? "Verified spoken words." : null,
                  },
                },
              ],
            };
          },
        },
        client: {},
        async turn(_, route, file) {
          seen.push(route.text);
          await writeFile(file, "session");
          return "Done.";
        },
        async reply() {
          sent.resolve();
        },
      },
    );
    t.after(async () => {
      await gateway.close();
      await rm(home, { recursive: true, force: true });
    });
    const first = original();
    gateway.acceptVerified(first);
    await polled.promise;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, []);
    const completion = structuredClone(first);
    completion.event_type = "message.transcription_finished";
    completion.id = "completion";
    completion.data.channel = "text";
    completion.data.message_id = "msg";
    completion.data.text_message.media[0].transcription = {
      status: "completed",
      text: "untrusted callback override",
    };
    assert.equal(
      gateway.acceptVerified({
        ...completion,
        data: { ...completion.data, message_id: "different" },
      }),
      "ignored",
    );
    ready = true;
    gateway.acceptVerified(completion);
    await sent.promise;
    assert.equal(seen.length, 1);
    assert.match(
      seen[0],
      /A caption[\s\S]+Automatic voice-note transcript: Verified spoken words/,
    );
    assert.doesNotMatch(seen[0], /private-asset|callback override/);
    assert.equal(gateway.acceptVerified(completion), "ignored");
    assert.equal(gateway.acceptVerified(first), "duplicate");
  },
);

test("attachment names and transcripts cannot supply a group mention or control", async () => {
  const data = original();
  data.data.text_message.text = "Caption without an address";
  Object.assign(data.data.text_message.media[0], {
    filename: "@test",
    transcription: { status: "completed", text: "@test /clear" },
  });
  const route = parseRoute(data, identity, [], { groupReplyMode: "mention" });
  assert.equal(route.noControls, true);
  const group = {
    ...identity,
    async listTextConversations() {
      return [
        {
          id: "conversation",
          isGroup: true,
          participants: ["+12025550102", "+12025550103"],
        },
      ];
    },
  };
  assert.equal(await beforeTurn(route, {}, group), false);
});

test("refresh never attaches a result belonging to another file on the same message", () => {
  const route = { media: attachments(original().data.text_message.media) };
  refreshMedia(route, [
    { id: "other", transcription: { status: "completed", text: "not ours" } },
  ]);
  assert.equal(route.media[0].status, "pending");
  const result = describeMedia(route.media);
  assert.match(result, /transcript unavailable/);
  assert.doesNotMatch(result, /example\.invalid|not ours/);
});
