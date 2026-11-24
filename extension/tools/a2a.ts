import { z } from "zod";
import { runTool } from "../errors.ts";
import { formatJson } from "../format.ts";
import { approveOutbound } from "../permissions.ts";
import type { RegisteredTool, ToolDeps } from "./types.ts";

const callArgs = {
  cardUrl: z.string().url().describe("A2A Agent Card URL."),
  text: z.string().min(1).describe("Task text."),
  contextId: z.string().describe("Optional context to continue.").optional(),
  taskId: z
    .string()
    .describe("Optional task requesting more input.")
    .optional(),
  messageId: z.string().describe("Stable idempotency id.").optional(),
};

const checkArgs = {
  cardUrl: z.string().url().describe("A2A Agent Card URL."),
  taskId: z.string().min(1).describe("Remote task id."),
  wait: z
    .boolean()
    .describe("Wait until the task reaches a final or input-required state.")
    .optional(),
};

const replyArgs = {
  cardUrl: z.string().url().describe("A2A Agent Card URL."),
  taskId: z.string().min(1).describe("Remote task id."),
  text: z.string().min(1).describe("Reply text."),
  messageId: z.string().describe("Stable idempotency id.").optional(),
};
const historyCommonArgs = {
  direction: z.enum(["inbound", "outbound", "both"]).optional(),
  requesterHandle: z.string().min(1).optional(),
  workerHandle: z.string().min(1).optional(),
  contextId: z.string().min(1).optional(),
  query: z.string().min(1).max(500).optional(),
  since: z
    .string()
    .min(1)
    .describe("ISO 8601 lower timestamp bound.")
    .optional(),
  cursor: z
    .string()
    .min(1)
    .describe("Opaque next_cursor from the previous page.")
    .optional(),
  limit: z.number().int().min(1).max(100).default(50),
};
const taskHistoryArgs = {
  ...historyCommonArgs,
  state: z
    .enum([
      "submitted",
      "working",
      "input_required",
      "auth_required",
      "completed",
      "failed",
      "canceled",
      "rejected",
    ])
    .optional(),
};
const messageHistoryArgs = {
  ...historyCommonArgs,
  taskId: z.string().min(1).optional(),
  role: z.enum(["caller", "agent"]).optional(),
};

type CallArgs = z.infer<z.ZodObject<typeof callArgs>>;
type CheckArgs = z.infer<z.ZodObject<typeof checkArgs>>;
type ReplyArgs = z.infer<z.ZodObject<typeof replyArgs>>;
type TaskHistoryArgs = z.infer<z.ZodObject<typeof taskHistoryArgs>>;
type MessageHistoryArgs = z.infer<z.ZodObject<typeof messageHistoryArgs>>;

async function clientFor(deps: ToolDeps): Promise<any> {
  const identity = await deps.runtime.getIdentity();
  const factory = (identity as any).a2aClient;
  if (typeof factory !== "function") {
    throw new Error(
      "This A2A tool requires @inkbox/sdk with identity.a2aClient() support.",
    );
  }
  return factory.call(identity);
}

export function a2aTools(deps: ToolDeps): RegisteredTool[] {
  const { config } = deps;
  return [
    {
      name: "inkbox_a2a_call",
      group: "a2a",
      defaultEnabled: true,
      definition: {
        description:
          "Send a task to an A2A 1.0 Agent Card. Keep the returned task and context ids for later checks or replies.",
        args: callArgs,
        async execute(args: CallArgs, ctx) {
          return runTool(async () => {
            await approveOutbound(ctx, config, {
              tool: "inkbox_a2a_call",
              recipients: [args.cardUrl],
              summary: `Send an A2A task to ${args.cardUrl}`,
              metadata: { cardUrl: args.cardUrl },
            });
            const a2a = await clientFor(deps);
            try {
              const target = await a2a.fetchCard(args.cardUrl);
              const messageId = args.messageId ?? ctx.callId;
              const result = await a2a.send(target, {
                text: args.text,
                contextId: args.contextId,
                taskId: args.taskId,
                messageId,
              });
              return formatJson(result);
            } finally {
              a2a.close?.();
            }
          });
        },
      },
    },
    {
      name: "inkbox_a2a_check",
      group: "a2a",
      defaultEnabled: true,
      definition: {
        description:
          "Fetch an A2A task, or wait until it reaches a final or input-required state.",
        args: checkArgs,
        async execute(args: CheckArgs) {
          return runTool(async () => {
            const a2a = await clientFor(deps);
            try {
              const target = await a2a.fetchCard(args.cardUrl);
              const task = args.wait
                ? await a2a.wait(target, args.taskId)
                : await a2a.getTask(target, args.taskId);
              return formatJson(task);
            } finally {
              a2a.close?.();
            }
          });
        },
      },
    },
    {
      name: "inkbox_a2a_reply",
      group: "a2a",
      defaultEnabled: true,
      definition: {
        description: "Reply to a remote A2A task that requested more input.",
        args: replyArgs,
        async execute(args: ReplyArgs, ctx) {
          return runTool(async () => {
            await approveOutbound(ctx, config, {
              tool: "inkbox_a2a_reply",
              recipients: [args.cardUrl],
              summary: `Reply to A2A task ${args.taskId} at ${args.cardUrl}`,
              metadata: { cardUrl: args.cardUrl, taskId: args.taskId },
            });
            const a2a = await clientFor(deps);
            try {
              const target = await a2a.fetchCard(args.cardUrl);
              const messageId = args.messageId ?? ctx.callId;
              const result = await a2a.send(target, {
                taskId: args.taskId,
                text: args.text,
                messageId,
              });
              return formatJson(result);
            } finally {
              a2a.close?.();
            }
          });
        },
      },
    },
    {
      name: "inkbox_list_a2a_tasks",
      group: "a2a",
      defaultEnabled: true,
      definition: {
        description:
          "List this identity's A2A task history. Direction defaults to inbound; filter by participants, state, context, keywords, or timestamp and follow next_cursor for more.",
        args: taskHistoryArgs,
        async execute(args: TaskHistoryArgs) {
          return runTool(async () => {
            const identity = await deps.runtime.getIdentity();
            const list = (identity as any).a2aTasks;
            if (typeof list !== "function") {
              throw new Error(
                "This A2A tool requires @inkbox/sdk with identity.a2aTasks() support.",
              );
            }
            return formatJson(
              await list.call(identity, {
                direction: args.direction,
                requesterHandle: args.requesterHandle,
                workerHandle: args.workerHandle,
                state: args.state,
                contextId: args.contextId,
                q: args.query,
                since: args.since,
                cursor: args.cursor,
                limit: args.limit,
              }),
            );
          });
        },
      },
    },
    {
      name: "inkbox_list_a2a_messages",
      group: "a2a",
      defaultEnabled: true,
      definition: {
        description:
          "List messages from this identity's inbound and outbound A2A history. Filter by direction, participants, task, context, role, keywords, or timestamp and follow next_cursor for more.",
        args: messageHistoryArgs,
        async execute(args: MessageHistoryArgs) {
          return runTool(async () => {
            const identity = await deps.runtime.getIdentity();
            const list = (identity as any).a2aMessages;
            if (typeof list !== "function") {
              throw new Error(
                "This A2A tool requires @inkbox/sdk with identity.a2aMessages() support.",
              );
            }
            return formatJson(
              await list.call(identity, {
                direction: args.direction,
                requesterHandle: args.requesterHandle,
                workerHandle: args.workerHandle,
                taskId: args.taskId,
                contextId: args.contextId,
                role: args.role,
                q: args.query,
                since: args.since,
                cursor: args.cursor,
                limit: args.limit,
              }),
            );
          });
        },
      },
    },
  ];
}
