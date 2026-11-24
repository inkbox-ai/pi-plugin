// SDK summaries expose SMS membership; the signed notification does not.
export async function findTextConversation(route, identity) {
  const limit = 200;
  const seenPages = new Set();
  for (let offset = 0; ; ) {
    const page = await identity.listTextConversations({
      participants: [route.sender],
      includeGroups: true,
      limit,
      offset,
    });
    const matches = page.filter((item) => item.id === route.conversation);
    if (matches.length) return matches.length === 1 ? matches[0] : null;
    if (page.length < limit) return null;
    const fingerprint = JSON.stringify(page.map((item) => item.id));
    if (seenPages.has(fingerprint)) return null;
    seenPages.add(fingerprint);
    offset += page.length;
  }
}

export async function archivedSlackSource(route, client) {
  const match = /^(\d{1,12})\.(\d{1,6})$/.exec(route.message);
  if (!match) return null;
  const ticks = BigInt(match[1]) * 1000000n + BigInt(match[2].padEnd(6, "0"));
  const ts = (n) =>
    String(n / 1000000n) + "." + String(n % 1000000n).padStart(6, "0");
  const page = await client.slack.listArchivedMessages(route.connection, {
    conversationId: route.conversation,
    afterTs: ts(ticks - 1n),
    beforeTs: ts(ticks + 1n),
    limit: 2,
  });
  const source = page.messages[0];
  if (
    page.nextCursor ||
    page.messages.length !== 1 ||
    !source?.id ||
    source.connectionId !== route.connection ||
    source.conversationId !== route.conversation ||
    source.messageTs !== route.message ||
    source.userId !== route.actor ||
    source.source !== "event" ||
    (route.archivedMessage && route.archivedMessage !== source.id) ||
    (source.threadTs === source.messageTs ? "" : (source.threadTs ?? "")) !==
      (route.subthread === route.message ? "" : (route.subthread ?? ""))
  )
    return null;
  return source;
}
