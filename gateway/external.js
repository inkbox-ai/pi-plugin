import { digest } from "./channels.js";

const identifier = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
export class InvalidExternalEvent extends Error {}

export function externalRoute(event, allowed = []) {
  const data = event.data;
  if (
    !identifier(data?.source?.id) ||
    !identifier(data.event_id) ||
    !identifier(data.delivery_id)
  ) {
    throw new InvalidExternalEvent("Invalid external event identifiers.");
  }
  const source = data.source.id;
  if (allowed.length && !allowed.includes(source)) return null;
  const route = {
    channel: "external",
    sender: source,
    conversation: source,
    thread: digest("external", source),
    message: data.delivery_id,
    externalEvent: data.event_id,
    noControls: true,
  };
  if (data.handler?.type !== "agent") {
    return {
      ...route,
      text: "",
      reportError: "This gateway supports agent handlers, not script handlers.",
    };
  }
  const request = data.request;
  if (
    typeof request?.body !== "string" ||
    !["utf8", "base64"].includes(request.body_encoding)
  ) {
    throw new InvalidExternalEvent("Invalid external request.");
  }
  const bytes = Buffer.from(request.body, request.body_encoding);
  if (bytes.length > 64 * 1024)
    return {
      ...route,
      text: "",
      reportError: "The incoming body exceeds the 64 KiB agent input limit.",
    };
  route.text = JSON.stringify({
    source: data.source.name,
    instructions: data.source.instructions,
    senderSignatureVerified: data.signature_verified === true,
    method: request.method,
    contentType: request.content_type,
    bodyEncoding: request.body_encoding,
    body: request.body,
  });
  return route;
}

export async function reportExternalFailure(route, client, identity) {
  try {
    await client.inbound.reportInboundEventResult(
      identity.agentHandle,
      route.sender,
      route.externalEvent,
      {
        status: "failed",
        deliveryId: route.message,
        error: route.reportError || "Pi could not process the external event.",
      },
    );
  } catch (error) {
    // A replay has replaced the delivery, or the source is gone.
    if (![404, 409].includes(error?.statusCode)) throw error;
  }
}
