import test from "node:test";
import assert from "node:assert/strict";
import { deliveryNotification } from "../gateway/delivery.js";

test("delivery receipts match the channel's owning resource and outbound message ID", () => {
  const identity = {
    id: "agent-a",
    mailbox: { id: "mail-a" },
    phoneNumber: { number: "+12025550122" },
    imessageEnabled: true,
  };
  const event = (type, data) => ({ id: "webhook-id", event_type: type, data });
  const record = { id: "sdk-message-id", direction: "outbound" };
  const sms = (number) =>
    event("text.delivery_failed", {
      text_message: { ...record, local_phone_number: number },
    });
  const mail = (mailbox) =>
    event("message.failed", {
      message: {
        ...record,
        mailbox_id: mailbox,
        message_id: "<rfc-id@example.com>",
      },
    });
  const whatsapp = (owner) =>
    event("whatsapp.delivery_unconfirmed", {
      message: { ...record, agent_identity_id: owner },
    });
  assert.deepEqual(deliveryNotification(mail("mail-a"), identity), {
    channel: "email",
    state: "failed",
    message: "sdk-message-id",
  });
  assert.deepEqual(deliveryNotification(sms("+12025550122"), identity), {
    channel: "sms",
    state: "failed",
    message: "sdk-message-id",
  });
  assert.deepEqual(deliveryNotification(whatsapp("agent-a"), identity), {
    channel: "whatsapp",
    state: "uncertain",
    message: "sdk-message-id",
  });
  for (const foreign of [
    mail("mail-b"),
    sms("+12025550123"),
    whatsapp("agent-b"),
    event("imessage.delivery_failed", {
      identity_id: "agent-b",
      message: record,
    }),
  ])
    assert.equal(deliveryNotification(foreign, identity), undefined);
  for (const incomplete of [
    sms(undefined),
    mail(undefined),
    event("imessage.delivery_failed", { message: record }),
  ])
    assert.equal(
      deliveryNotification(incomplete, { id: "agent-a" }),
      undefined,
    );
  assert.equal(
    deliveryNotification(
      event("text.delivery_failed", { message: record }),
      identity,
    ),
    undefined,
  );
});
