import assert from "node:assert/strict";
import test from "node:test";
import {
  createContactResolver,
  describeSender,
  eventPeople,
} from "../gateway/contacts.js";

const event = (data) => ({ id: "evt", data });
const nobody = { contact: null, memories: [], agent: null };

test("a text event's single contact is the sender, with their memories", () => {
  const people = eventPeople(
    event({
      contacts: [
        null,
        {
          id: " contact-1 ",
          name: " Alex ",
          memories: ["Prefers short answers.", 7, null, "Works nights."],
        },
      ],
    }),
    "sms",
    "+12025550102",
  );
  assert.equal(people.contact.id, "contact-1");
  assert.equal(people.contact.name, "Alex");
  assert.deepEqual(people.memories, [
    "Prefers short answers.",
    "Works nights.",
  ]);
  assert.equal(people.agent, null);

  const unnamed = eventPeople(
    event({ contacts: [{ id: "contact-2" }] }),
    "imessage",
    "+12025550102",
  );
  assert.equal(unnamed.contact.id, "contact-2");
  assert.equal(unnamed.contact.name, undefined);
  assert.deepEqual(unnamed.memories, []);
});

test("several contacts on a text event, or none, name nobody", () => {
  for (const data of [
    {
      contacts: [
        { id: "contact-1", memories: ["a"] },
        { id: "contact-2", memories: ["b"] },
      ],
    },
    { contacts: [] },
    // Memories belong to an identified contact or to nobody.
    { contacts: [{ name: "No id", memories: ["a"] }] },
    { contacts: [{ id: "  ", memories: ["a"] }] },
    { contacts: "contact-1" },
    {},
  ])
    for (const channel of ["sms", "imessage", "whatsapp"])
      assert.deepEqual(
        eventPeople(event(data), channel, "+12025550102"),
        nobody,
      );
  assert.deepEqual(eventPeople(undefined, "sms", "+12025550102"), nobody);
  assert.deepEqual(eventPeople({ id: "evt" }, "sms", "+12025550102"), nobody);
});

test("mail picks the contact in the from bucket whose address is the sender", () => {
  const contacts = [
    { id: "to-contact", bucket: "to", address: "alex@example.com" },
    { id: "cc-contact", bucket: "cc", address: "sam@example.com" },
    {
      id: "other-from",
      bucket: "from",
      address: "someone@example.com",
      memories: ["not theirs"],
    },
    {
      id: "from-contact",
      name: "Alex",
      bucket: "from",
      address: " Alex@Example.com ",
      memories: ["Asked about invoices."],
    },
  ];
  const people = eventPeople(event({ contacts }), "email", "alex@example.com");
  assert.equal(people.contact.id, "from-contact");
  assert.equal(people.contact.name, "Alex");
  assert.deepEqual(people.memories, ["Asked about invoices."]);

  // A lone contact is not enough on mail: it may be a recipient.
  for (const only of [contacts[0], contacts[2]])
    assert.deepEqual(
      eventPeople(event({ contacts: [only] }), "email", "alex@example.com"),
      nobody,
    );
});

test("Slack takes the contact id of the event and never its memories", () => {
  assert.deepEqual(
    eventPeople(
      event({
        contact_id: " contact-9 ",
        contacts: [{ id: "contact-1", name: "Alex", memories: ["a"] }],
        agent_identities: [{ id: "agent-2" }],
      }),
      "slack",
      "TEAM:USER",
    ),
    { contact: { id: "contact-9" }, memories: [], agent: null },
  );
  for (const data of [{}, { contact_id: "  " }, { contact_id: 7 }])
    assert.deepEqual(eventPeople(event(data), "slack", "TEAM:USER"), nobody);
});

test("a peer agent on the event is described by its identity, handle and name", () => {
  const people = eventPeople(
    event({
      agent_identities: [
        { id: "agent-2", agent_handle: "helper", display_name: "Helper" },
      ],
    }),
    "sms",
    "+12025550102",
  );
  assert.deepEqual(people, {
    contact: null,
    memories: [],
    agent: {
      agentIdentityId: "agent-2",
      agentHandle: "helper",
      name: "Helper",
    },
  });
  const mail = eventPeople(
    event({
      agent_identities: [
        { id: "agent-3", bucket: "to", address: "helper@example.com" },
        {
          id: "agent-2",
          agent_handle: "helper",
          bucket: "from",
          address: "helper@example.com",
        },
      ],
    }),
    "email",
    "helper@example.com",
  );
  assert.equal(mail.agent.agentIdentityId, "agent-2");
  assert.equal(mail.agent.agentHandle, "helper");
});

function addressBook(answer) {
  const queries = [];
  return {
    queries,
    client: {
      contacts: {
        async lookup(query) {
          queries.push(query);
          return answer(query);
        },
      },
    },
  };
}
const record = {
  id: "contact-1",
  preferredName: "Alex",
  givenName: "Alexander",
  familyName: "Example",
  companyName: "Example Co",
  emails: [
    { value: "old@example.com" },
    { value: " alex@example.com ", isPrimary: true },
    { value: "" },
  ],
  phones: [{ value: "+12025550102", isPrimary: true }],
};

test("the resolver looks up an email or a phone number and summarizes the one match", async () => {
  const book = addressBook(() => [record]);
  const resolve = createContactResolver(book.client);
  assert.deepEqual(await resolve(" Alex@Example.com "), {
    id: "contact-1",
    name: "Alex",
    company: "Example Co",
    emails: ["alex@example.com", "old@example.com"],
    phones: ["+12025550102"],
  });
  await resolve("+12025550102");
  assert.deepEqual(book.queries, [
    { email: "alex@example.com" },
    { phone: "+12025550102" },
  ]);

  const plain = addressBook(() => [
    { id: "contact-2", givenName: "Sam", familyName: "Example" },
  ]);
  const summary = await createContactResolver(plain.client)("sam@example.com");
  assert.equal(summary.name, "Sam Example");
  assert.equal(summary.company, undefined);
  assert.deepEqual(summary.emails, []);
  assert.deepEqual(summary.phones, []);
});

test("only exactly one match identifies the sender", async () => {
  for (const matches of [
    [],
    [record, { ...record, id: "contact-2" }],
    [{ preferredName: "No id" }],
    [null],
    null,
    { id: "contact-1" },
  ]) {
    const book = addressBook(() => matches);
    assert.equal(
      await createContactResolver(book.client)("alex@example.com"),
      null,
    );
    assert.equal(book.queries.length, 1);
  }
});

test("addresses that cannot be in the address book are not looked up", async () => {
  const book = addressBook(() => [record]);
  const resolve = createContactResolver(book.client);
  for (const address of ["", "   ", undefined, null, 7, "TEAM:USER"])
    assert.equal(await resolve(address), null);
  assert.deepEqual(book.queries, []);
});

test("hits, misses and failures are each cached for five minutes", async () => {
  let now = 1_000_000;
  let failing = false;
  const book = addressBook((query) => {
    if (failing) throw new Error("address book unavailable");
    return query.email === "alex@example.com" ? [record] : [];
  });
  const resolve = createContactResolver(book.client, () => now);

  assert.equal((await resolve("alex@example.com")).id, "contact-1");
  assert.equal(await resolve("stranger@example.com"), null);
  failing = true;
  assert.equal(await resolve("+12025550102"), null);
  assert.equal(book.queries.length, 3);

  // Within the window nothing is asked again, in any spelling of the address.
  failing = false;
  now += 299_999;
  assert.equal((await resolve("ALEX@example.com ")).id, "contact-1");
  assert.equal(await resolve("stranger@example.com"), null);
  assert.equal(await resolve("+12025550102"), null);
  assert.equal(book.queries.length, 3);

  now += 1;
  assert.equal((await resolve("alex@example.com")).id, "contact-1");
  assert.equal(await resolve("stranger@example.com"), null);
  assert.equal(await resolve("+12025550102"), null);
  assert.deepEqual(book.queries.slice(3), [
    { email: "alex@example.com" },
    { email: "stranger@example.com" },
    { phone: "+12025550102" },
  ]);
});

test("an address book that cannot be reached never fails the message", async () => {
  for (const client of [
    {},
    { contacts: {} },
    {
      contacts: {
        lookup() {
          throw new Error("synchronous failure");
        },
      },
    },
    {
      contacts: {
        lookup: async () => {
          throw Object.assign(new Error("denied"), { statusCode: 403 });
        },
      },
    },
  ])
    assert.equal(await createContactResolver(client)("alex@example.com"), null);
});

test("the sender card prefers the address book, then the event's contact, then a one-to-one peer agent", async () => {
  const found = { id: "book-contact", name: "From the book" };
  const eventContact = { id: "event-contact", name: "From the event" };
  const eventAgent = { agentIdentityId: "agent-2", agentHandle: "helper" };
  const asked = [];
  const hit = async (address) => (asked.push(address), found);
  const miss = async (address) => (asked.push(address), null);
  const route = {
    channel: "sms",
    sender: "+12025550102",
    eventContact,
    eventAgent,
  };

  assert.equal(await describeSender(route, hit), found);
  assert.equal(await describeSender(route, miss), eventContact);
  assert.equal(
    await describeSender({ ...route, eventContact: null }, miss),
    eventAgent,
  );
  assert.equal(
    await describeSender({ ...route, eventContact: { name: "No id" } }, miss),
    eventAgent,
  );
  assert.equal(
    await describeSender(
      { ...route, eventContact: null, eventAgent: null },
      miss,
    ),
    null,
  );
  // In a group the event does not say which member its contact or agent
  // entry names: only the sender's own address-book record is used.
  assert.equal(await describeSender({ ...route, group: true }, miss), null);
  assert.equal(
    await describeSender({ ...route, group: true, eventContact: null }, miss),
    null,
  );
  assert.equal(await describeSender({ ...route, group: true }, hit), found);
  assert.deepEqual(asked, Array(8).fill("+12025550102"));
});

test("Slack, agent tasks and external events never query the address book", async () => {
  const lookup = () => assert.fail("no lookup expected");
  const eventContact = { id: "event-contact" };
  assert.equal(
    await describeSender(
      { channel: "slack", sender: "TEAM:USER", eventContact },
      lookup,
    ),
    eventContact,
  );
  // A Slack event names its own actor's contact, also in a channel.
  assert.equal(
    await describeSender(
      { channel: "slack", sender: "TEAM:USER", group: true, eventContact },
      lookup,
    ),
    eventContact,
  );
  assert.equal(
    await describeSender(
      {
        channel: "slack",
        sender: "TEAM:USER",
        eventContact: null,
        eventAgent: null,
      },
      lookup,
    ),
    null,
  );
  for (const channel of ["a2a", "external"])
    assert.equal(
      await describeSender(
        {
          channel,
          sender: "peer",
          eventContact,
          eventAgent: { agentIdentityId: "a" },
        },
        lookup,
      ),
      null,
    );
});
