export async function slackConnectionStatus(client, identityId) {
  try {
    const { connections } = await client.slack.listConnections(identityId);
    return connections.some(
      (c) => c.identityId === identityId && c.status === "connected",
    );
  } catch {
    return undefined;
  }
}

// Only these public-facing identity facts can cross into a messaging turn.
export function identityStatus(identity, slackEnabled, slackConnected) {
  return {
    handle: identity.agentHandle,
    mailboxAddress: identity.emailAddress || identity.mailbox?.emailAddress,
    smsNumber: identity.phoneNumber?.number,
    channelFacts: {
      emailAssigned: Boolean(identity.mailbox || identity.emailAddress),
      smsAssigned: Boolean(identity.phoneNumber?.number),
      smsLineStatus: identity.phoneNumber?.status,
      outboundSmsStatus: identity.phoneNumber?.smsStatus,
      imessageEnabled: identity.imessageEnabled,
      dedicatedIMessageNumber: identity.imessageNumber?.number,
      whatsappEnabled: identity.whatsappEnabled,
      whatsappConfigured: identity.whatsappConfigured,
      whatsappNumber: identity.whatsappNumber,
      slackConnected,
      slackGatewayEnabled: slackEnabled === true,
    },
  };
}
