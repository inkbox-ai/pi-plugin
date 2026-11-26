import { CallMode, type CallOrigin, type VoicemailDetection } from "@inkbox/sdk";
import { z } from "zod";
import { runTool } from "../errors.ts";
import { approveOutbound } from "../permissions.ts";
import type { RegisteredTool, ToolDeps } from "./types.ts";

const placeCallArgs = {
  toNumber: z.string().describe("Phone number to call, in E.164 format (e.g. +14155550123)."),
  purpose: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "What the call is for. This becomes the call agent's task, so state the outcome wanted and who is being called.",
    ),
  openingMessage: z
    .string()
    .max(500)
    .describe("Optional first thing to say when the call connects.")
    .optional(),
  context: z
    .string()
    .max(2000)
    .describe("Optional background facts the call agent may need after the opening.")
    .optional(),
  origination: z
    .enum(["dedicated_number", "shared_imessage_number", "dedicated_imessage_number"])
    .describe(
      'Which line to call from. "dedicated_number" is your own phone number, the line SMS uses. The iMessage values call someone over the iMessage line you already message them on; a shared line only reaches people connected to you over iMessage. Omit to use your phone number.',
    )
    .optional(),
  voicemailDetection: z
    .enum(["enabled", "disabled"])
    .describe("Whether the call ends when voicemail answers. Omit to keep the default.")
    .optional(),
};
type PlaceCallArgs = z.infer<z.ZodObject<typeof placeCallArgs>>;

const listCallsArgs = {
  limit: z.number().int().min(1).max(50).describe("How many calls to list. Default 10.").optional(),
};
const transcriptArgs = {
  callId: z.string().min(1).describe("Call ID from inkbox_list_calls or a finished-call notice."),
};

/** The task brief the call agent receives. */
export function callBrief(args: Pick<PlaceCallArgs, "purpose" | "openingMessage" | "context">) {
  return [
    args.purpose.trim(),
    args.openingMessage?.trim() && "Open the call with: " + args.openingMessage.trim(),
    args.context?.trim() && "Background: " + args.context.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const speaker = (party: string) =>
  party === "local" ? "Agent" : party === "remote" ? "Other party" : "System";

export function callTools({ runtime, config }: ToolDeps): RegisteredTool[] {
  return [
    {
      name: "inkbox_place_call",
      group: "calls",
      defaultEnabled: true,
      definition: {
        description:
          "Place a phone call that Inkbox's call agent conducts for you. Give it a concrete purpose; the transcript and any promised follow-ups come back when the call ends.",
        args: placeCallArgs,
        async execute(args: PlaceCallArgs, ctx) {
          return runTool(async () => {
            const toNumber = args.toNumber.trim();
            if (!/^\+[1-9]\d{6,14}$/.test(toNumber))
              throw new Error("`toNumber` must be an E.164 phone number such as +14155550123.");
            const reason = callBrief(args);
            await approveOutbound(ctx, config, {
              tool: "inkbox_place_call",
              recipients: [toNumber],
              summary: `Place a phone call to ${toNumber}: ${args.purpose.trim()}`,
            });
            const identity = await runtime.getIdentity();
            ctx.abort?.throwIfAborted();
            const call = await identity.placeCall({
              toNumber,
              mode: CallMode.HOSTED_AGENT,
              reason,
              ...(args.origination ? { origination: args.origination as CallOrigin } : {}),
              ...(args.voicemailDetection
                ? { voicemailDetection: args.voicemailDetection as VoicemailDetection }
                : {}),
            });
            return {
              title: `Call placed to ${toNumber}`,
              output: `Call placed id=${call.id} to=${toNumber} status=${call.status}. The call agent is handling the conversation; you are told the result when the call ends. Do not say the call succeeded until then.`,
            };
          });
        },
      },
    },
    {
      name: "inkbox_list_calls",
      group: "calls",
      defaultEnabled: true,
      definition: {
        description: "List this identity's recent phone calls, newest first, with direction, status and call ID.",
        args: listCallsArgs,
        async execute(args: z.infer<z.ZodObject<typeof listCallsArgs>>) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const calls = await identity.listCalls({ limit: args.limit ?? 10 });
            if (!calls.length) return "No calls found.";
            return calls
              .map((call) =>
                [
                  `id=${call.id}`,
                  call.direction,
                  `with=${call.remotePhoneNumber}`,
                  `status=${call.status}`,
                  call.hangupReason && `ended_by=${call.hangupReason}`,
                  call.startedAt && `started=${call.startedAt.toISOString()}`,
                  call.reason && `purpose=${JSON.stringify(call.reason.slice(0, 200))}`,
                ]
                  .filter(Boolean)
                  .join(" "),
              )
              .join("\n");
          });
        },
      },
    },
    {
      name: "inkbox_list_call_transcripts",
      group: "calls",
      defaultEnabled: true,
      definition: {
        description: "Read the transcript of one phone call by call ID.",
        args: transcriptArgs,
        async execute(args: z.infer<z.ZodObject<typeof transcriptArgs>>) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const lines = await identity.listTranscripts(args.callId.trim());
            if (!lines.length) return "No transcript was captured for this call.";
            return lines
              .sort((a, b) => a.seq - b.seq)
              .map((line) => speaker(line.party) + ": " + line.text)
              .join("\n");
          });
        },
      },
    },
  ];
}
