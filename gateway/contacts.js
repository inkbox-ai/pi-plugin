// Who sent a message: the people a signed event names, and the contact record
// the address resolves to in the identity's address book.

const TTL_MS = 300_000;
const MAX_ENTRIES = 2000;
const lower = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");
const text = (s, max = 200) =>
  typeof s === "string" && s.trim() ? s.trim().slice(0, max) : undefined;

/** Contact, memories and peer agent that the event itself attributes to the sender. */
export function eventPeople(event, channel, sender) {
  const data = event?.data ?? {};
  const from = lower(sender);
  const pick = (items) => {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (channel === "email")
      return list.find(
        (item) => item.bucket === "from" && lower(item.address) === from,
      );
    return list.length === 1 ? list[0] : undefined;
  };
  if (channel === "slack")
    return {
      contact: text(data.contact_id) ? { id: data.contact_id.trim() } : null,
      memories: [],
      agent: null,
    };
  const contact = pick(data.contacts);
  const agent = pick(data.agent_identities);
  return {
    contact: text(contact?.id)
      ? { id: contact.id.trim(), name: text(contact.name) }
      : null,
    memories:
      text(contact?.id) && Array.isArray(contact.memories)
        ? contact.memories.filter((m) => typeof m === "string")
        : [],
    agent: text(agent?.id)
      ? {
          agentIdentityId: agent.id.trim(),
          agentHandle: text(agent.agent_handle),
          name: text(agent.display_name),
        }
      : null,
  };
}

function summarize(contact) {
  const values = (items) =>
    (Array.isArray(items) ? items : [])
      .filter((item) => text(item?.value))
      .sort(
        (a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)),
      )
      .map((item) => item.value.trim())
      .slice(0, 8);
  return {
    id: contact.id,
    name:
      text(contact.preferredName) ??
      text([contact.givenName, contact.familyName].filter(Boolean).join(" ")),
    company: text(contact.companyName),
    emails: values(contact.emails),
    phones: values(contact.phones),
  };
}

/** Address-book lookup by exact email or phone. Misses and failures are cached too. */
export function createContactResolver(client, now = Date.now) {
  const cache = new Map();
  return async function resolveContact(address) {
    const key = lower(address);
    if (!key || key.includes(":")) return null;
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.value;
    let value = null;
    try {
      const matches = await client.contacts.lookup(
        key.includes("@") ? { email: key } : { phone: key },
      );
      if (Array.isArray(matches) && matches.length === 1 && matches[0]?.id)
        value = summarize(matches[0]);
    } catch {
      // An address-book failure must never drop the message.
    }
    cache.delete(key);
    cache.set(key, { value, expires: now() + TTL_MS });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return value;
  };
}

/** The card shown to the agent: the address-book record, else what the event resolved. */
export async function describeSender(route, resolveContact) {
  if (route.channel === "a2a" || route.channel === "external") return null;
  const found =
    route.channel === "slack" ? null : await resolveContact(route.sender);
  if (found) return found;
  // In a group the event does not say which member its contact entry names.
  if (route.group && route.channel !== "slack") return null;
  return route.eventContact?.id ? route.eventContact : route.eventAgent;
}
