import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { runTool } from "../errors.ts";
import { formatJson } from "../format.ts";
import { localMediaPath, readFileWithCap } from "../media.ts";
import { idempotencyKey, requestKey } from "../message-key.ts";
import { approveOutbound } from "../permissions.ts";
import type { RegisteredTool, ToolDeps } from "./types.ts";

async function participants(identity: Awaited<ReturnType<ToolDeps["runtime"]["getIdentity"]>>, id: string): Promise<string[]> {
  const conversation = await identity.getWhatsAppConversation(id);
  const members = conversation.participants;
  if (conversation.agentIdentityId !== identity.id || conversation.id.toLowerCase() !== id.toLowerCase() ||
      conversation.unresolvedParticipantCount !== 0 || !Array.isArray(members) || !members.length ||
      !members.every(p => /^\+[1-9]\d{6,14}$/.test(p) && p !== conversation.localNumber) ||
      new Set(members).size !== members.length ||
      (conversation.isGroup ? conversation.remoteNumber !== null : members.length !== 1 || conversation.groupName != null)) {
    throw new Error("WhatsApp requires an owned conversation with known participants.");
  }
  return [...members].sort();
}

export function whatsappTools(deps: ToolDeps): RegisteredTool[] {
  const page = {
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  };
  type Spec = [
    string,
    string,
    Record<string, z.ZodType>,
    (args: any, ctx: any) => Promise<unknown>,
  ];
  const read = (method: string) => async (args: any) => {
    const identity = await deps.runtime.getIdentity();
    const call = (identity as any)[method];
    if (typeof call !== "function")
      throw new Error("WhatsApp requires Inkbox SDK 0.7.29 or newer.");
    if (method === "getWhatsAppStatus") {
      const status = await call.call(identity);
      let limits = null;
      try {
        if (typeof identity.getWhatsAppLimits === "function")
          limits = await identity.getWhatsAppLimits();
      } catch {
        /* Older API: status and history remain usable. */
      }
      return { status, limits };
    }
    if (method === "getWhatsAppConversation")
      return call.call(identity, args.conversationId);
    if (method === "getWhatsAppMessage")
      return call.call(identity, args.messageId);
    if (method === "getWhatsAppMedia") return call.call(identity, args.mediaId);
    if (method === "markWhatsAppRead")
      return call.call(identity, args.conversationId, args.throughMessageId);
    return call.call(identity, args);
  };
  const specs: Spec[] = [
    [
      "get_whatsapp_status",
      "Read current dedicated WhatsApp availability. Request Access in the console; tools cannot grant it.",
      {},
      read("getWhatsAppStatus"),
    ],
    [
      "list_whatsapp_conversations",
      "List direct and existing group WhatsApp conversations and local unread counts.",
      { ...page },
      read("listWhatsAppConversations"),
    ],
    [
      "get_whatsapp_conversation",
      "Read one WhatsApp conversation's metadata.",
      { conversationId: z.string() },
      read("getWhatsAppConversation"),
    ],
    [
      "list_whatsapp_messages",
      "List WhatsApp messages newest first.",
      {
        ...page,
        conversationId: z.string().optional(),
        threadId: z.string().optional(),
      },
      read("listWhatsAppMessages"),
    ],
    [
      "get_whatsapp_message",
      "Read sending and delivery state without resending.",
      { messageId: z.string() },
      read("getWhatsAppMessage"),
    ],
    [
      "get_whatsapp_thread",
      "Read a chronological quoted-reply thread.",
      {
        messageId: z.string(),
        limit: page.limit,
        cursor: z.string().optional(),
      },
      async (args) =>
        (await deps.runtime.getIdentity()).getWhatsAppThread(args.messageId, {
          limit: args.limit,
          cursor: args.cursor,
        }),
    ],
    [
      "get_whatsapp_conversation_thread",
      "Read one conversation's quoted-reply thread.",
      {
        conversationId: z.string(),
        threadId: z.string(),
        limit: page.limit,
        cursor: z.string().optional(),
      },
      async (args) =>
        (await deps.runtime.getIdentity()).getWhatsAppConversationThread(
          args.conversationId,
          args.threadId,
          { limit: args.limit, cursor: args.cursor },
        ),
    ],
    [
      "get_whatsapp_reaction",
      "Read a reaction receipt; queued or uncertain is not applied.",
      { reactionId: z.string() },
      async (args) =>
        (await deps.runtime.getIdentity()).getWhatsAppReaction(args.reactionId),
    ],
    [
      "get_whatsapp_media",
      "Renew temporary media access by its owned ID.",
      { mediaId: z.string() },
      read("getWhatsAppMedia"),
    ],
    [
      "mark_whatsapp_read",
      "Mark local history read; no remote read receipt.",
      { conversationId: z.string(), throughMessageId: z.string() },
      read("markWhatsAppRead"),
    ],
    [
      "lookup_whatsapp_send",
      "Read-only recovery by the original key. Never resend an uncertain attempt.",
      { idempotencyKey: z.string() },
      async (args) => {
        const identity = await deps.runtime.getIdentity();
        return {
          messageId: await (
            await deps.runtime.getClient()
          ).messageSends.lookup({
            senderKind: "whatsapp_identity",
            senderId: identity.id,
            operation: "whatsapp.send",
            idempotencyKey: args.idempotencyKey,
          }),
        };
      },
    ],
    [
      "upload_whatsapp_media",
      "Upload one authorized local file (protocol maximum 20 MiB, current limits may be lower). Retain the owned media ID.",
      { mediaPath: z.string() },
      async (args, ctx) => {
        const filePath = await realpath(localMediaPath(args.mediaPath, ctx.directory));
        const content = await readFileWithCap(
          filePath,
          20 * 1024 * 1024,
          "upload",
        );
        if (!(await ctx.confirm("Upload WhatsApp media", filePath)))
          throw new Error("Upload was not approved.");
        const identity = await deps.runtime.getIdentity();
        ctx.abort?.throwIfAborted();
        return identity.uploadWhatsAppMedia({
          content,
          filename: basename(args.mediaPath),
        });
      },
    ],
    [
      "send_whatsapp",
      "Send WhatsApp text/media to one E.164 recipient string or an existing direct or group conversation. Specify exactly one destination. Explicit quoted replies require conversationId. Normal final answers reply automatically; do not duplicate them. Keep the original key/media ID after uncertainty.",
      {
        to: z
          .string()
          .regex(/^\+[1-9]\d{6,14}$/)
          .optional(),
        replyToMessageId: z.string().min(1).optional(),
        conversationId: z.string().optional(),
        text: z.string().optional(),
        mediaId: z.string().optional(),
        idempotencyKey,
      },
      async (args, ctx) => {
        if (
          Boolean(args.to) === Boolean(args.conversationId) ||
          !(args.text?.trim() || args.mediaId)
        )
          throw new Error(
            "Provide a recipient or existing conversation, and text or a media ID.",
          );
        if (args.replyToMessageId && !args.conversationId)
          throw new Error("Quoted replies require a conversation.");
        const identity = await deps.runtime.getIdentity();
        const recipients = args.to ? [args.to] : await participants(identity, args.conversationId);
        await approveOutbound(ctx, deps.config, {
          tool: "inkbox_send_whatsapp",
          summary: "Send WhatsApp message",
          recipients,
        });
        if (args.conversationId && JSON.stringify(await participants(identity, args.conversationId)) !== JSON.stringify(recipients)) {
          throw new Error("WhatsApp participants changed; review the new destination before sending.");
        }
        ctx.abort?.throwIfAborted();
        const { mediaId, ...target } = args;
        const key = requestKey(ctx, args.idempotencyKey);
        const message = await identity.sendWhatsApp({
          ...target,
          ...(mediaId ? { mediaIds: [mediaId] } : {}),
          idempotencyKey: key,
        });
        return { message, idempotencyKey: key };
      },
    ],
  ];
  for (const remove of [false, true])
    specs.push([
      remove ? "remove_whatsapp_reaction" : "send_whatsapp_reaction",
      remove
        ? "Remove this exact reaction revision. Keep the original key after uncertainty."
        : "React with a named reaction or custom emoji. Queued or uncertain is not applied; keep the original key.",
      remove
        ? { reactionId: z.string(), idempotencyKey: z.string().min(1) }
        : {
            messageId: z.string(),
            reaction: z
              .enum([
                "love",
                "like",
                "dislike",
                "laugh",
                "emphasize",
                "question",
                "eyes",
              ])
              .optional(),
            customEmoji: z
              .string()
              .min(1)
              .refine((value) => Array.from(value).length <= 32)
              .optional(),
            idempotencyKey: z.string().min(1),
          },
      async (args, ctx) => {
        const identity = await deps.runtime.getIdentity();
        const reaction = remove ? await identity.getWhatsAppReaction(args.reactionId) : undefined;
        if (remove && (!reaction || reaction.id !== args.reactionId || reaction.agentIdentityId !== identity.id || !reaction.targetMessageId))
          throw new Error("WhatsApp reaction does not belong to this identity.");
        const messageId = reaction?.targetMessageId ?? args.messageId;
        const message = await identity.getWhatsAppMessage(messageId);
        if (message.id !== messageId || message.agentIdentityId !== identity.id || !message.conversationId ||
            (reaction && reaction.conversationId !== message.conversationId))
          throw new Error("WhatsApp reaction target does not belong to this conversation.");
        const recipients = await participants(identity, message.conversationId);
        await approveOutbound(ctx, deps.config, {
          tool: remove ? "inkbox_remove_whatsapp_reaction" : "inkbox_send_whatsapp_reaction",
          summary: "Update WhatsApp reaction",
          recipients,
        });
        if (JSON.stringify(await participants(identity, message.conversationId)) !== JSON.stringify(recipients))
          throw new Error("WhatsApp participants changed; review the new destination before reacting.");
        ctx.abort?.throwIfAborted();
        return remove
          ? identity.removeWhatsAppReaction(
              args.reactionId,
              args.idempotencyKey,
            )
          : identity.sendWhatsAppReaction(args);
      },
    ]);
  return specs.map(([name, description, args, execute]) => ({
    name: `inkbox_${name}`,
    group: "whatsapp",
    defaultEnabled: true,
    definition: {
      description,
      args,
      async execute(input, ctx) {
        return runTool(async () => formatJson(await execute(input, ctx)));
      },
    },
  }));
}
