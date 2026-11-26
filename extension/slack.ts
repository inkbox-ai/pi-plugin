import type { Inkbox, SlackConnection } from "@inkbox/sdk";
export class SlackConnectionDenied extends Error {}
export async function ownSlackConnection(
  client: Inkbox,
  identityId: string,
  connectionId: string,
  workspaceId?: string,
  generation?: number,
): Promise<SlackConnection> {
  const matches = (
    await client.slack.listConnections(identityId)
  ).connections.filter((c) => c.id === connectionId);
  if (
    matches.length !== 1 ||
    matches[0]?.identityId !== identityId ||
    matches[0]?.status !== "connected" ||
    (workspaceId !== undefined && matches[0]?.workspaceId !== workspaceId) ||
    (generation !== undefined && matches[0]?.generation !== generation)
  )
    throw new SlackConnectionDenied(
      "Slack connection is not connected to this identity.",
    );
  return matches[0]!;
}
export function slackText(text: string): void {
  if (!text || [...text].length > 12_000 || text.includes("\0"))
    throw new Error(
      "Slack text must be 1–12000 characters without NUL characters.",
    );
}
