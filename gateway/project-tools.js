import { open, realpath, rename, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

import {
  encodeEditProposal,
  PROJECT_EDIT_TITLE,
  encodeProjectAction,
  PROJECT_ACTION_TITLE,
} from "./pi-rpc.js";
import {
  FILE_LIMIT as LIMIT,
  readableFiles,
  readProjectFile,
} from "./project-workspace.js";

const result = (text) => ({ content: [{ type: "text", text }], details: {} });

export default function register(pi) {
  const files = JSON.parse(process.env.INKBOX_PI_GRANTED_FILES ?? "[]");
  const confirmEdits = process.env.INKBOX_PI_CONFIRM_EDITS === "1";
  const workspace =
    confirmEdits && process.env.INKBOX_PI_READ_WORKSPACE === "1";
  if (!Array.isArray(files) || (!files.length && !confirmEdits)) return;
  const granted = new Set(files);
  const command =
    confirmEdits && JSON.parse(process.env.INKBOX_PI_TEST_ARGV || "null");
  const inventory = (signal) =>
    readableFiles(process.cwd(), granted, workspace, signal);
  const readTarget = (name, permitted = granted) =>
    readProjectFile(process.cwd(), name, permitted);
  const file = { type: "string", enum: files };
  if (files.length || workspace)
    pi.registerTool({
      name: "inkbox_project_read",
      label: "Read granted file",
      description: "Read one project file from the owner-approved read scope.",
      parameters: {
        type: "object",
        properties: { file: workspace ? { type: "string" } : file },
        required: ["file"],
        additionalProperties: false,
      },
      async execute(_, args, signal) {
        const allowed = granted.has(args.file)
          ? granted
          : await inventory(signal);
        return result((await readTarget(args.file, allowed)).text);
      },
    });
  if (confirmEdits) {
    if (files.length || workspace)
      pi.registerTool({
        name: "inkbox_project_search",
        label: "Search project files",
        description:
          "Find literal text in owner-granted files and optional tracked source. Returns matching file names, line numbers and excerpts.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1, maxLength: 256 },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(_, { query }, signal) {
          if (typeof query !== "string" || !query || query.length > 256)
            throw new Error("Provide a short literal search string.");
          const allowed = await inventory(signal);
          const matches = [];
          let bytes = 0,
            scanned = 0;
          for (const name of allowed) {
            signal?.throwIfAborted();
            if (bytes >= 8 * 1024 * 1024 || scanned++ >= 512) {
              matches.push("[Search stopped at scan limit.]");
              break;
            }
            let text;
            try {
              ({ text } = await readTarget(name, allowed));
            } catch {
              continue;
            } // Missing, oversized, linked, binary, or unreadable.
            bytes += Buffer.byteLength(text);
            const lines = text.split("\n");
            for (const [i, line] of lines.entries()) {
              const at = line.indexOf(query);
              if (at < 0) continue;
              matches.push(
                name +
                  ":" +
                  (i + 1) +
                  ": " +
                  line.slice(Math.max(0, at - 60), at + query.length + 100),
              );
              if (matches.length >= 20)
                return result(matches.join("\n") + "\n[Result limit reached.]");
            }
          }
          return result(matches.join("\n") || "No matches.");
        },
      });
    const action = async (ctx, signal, request) => {
      if (ctx?.mode !== "rpc")
        throw new Error("A verified gateway conversation is required.");
      signal?.throwIfAborted();
      const response = await ctx.ui.input(
        PROJECT_ACTION_TITLE,
        encodeProjectAction(request),
        { signal },
      );
      signal?.throwIfAborted();
      if (typeof response !== "string" || !response)
        throw new Error(
          "No verified result; the request may have been denied, expired or undelivered.",
        );
      return response;
    };
    if (command)
      pi.registerTool({
        name: "inkbox_project_test",
        label: "Run configured project test",
        description:
          "Request approval from the sender to run the owner's configured test in an isolated workspace. No command arguments can be supplied.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute(_, _args, signal, _update, ctx) {
          return result(await action(ctx, signal, { kind: "test", command }));
        },
      });
    pi.registerTool({
      name: "inkbox_project_ask",
      label: "Ask requester",
      description:
        "Ask a clarifying question in this verified conversation and wait for the requester's answer.",
      parameters: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
        additionalProperties: false,
      },
      async execute(_, { question }, signal, _update, ctx) {
        return result(
          await action(ctx, signal, { kind: "question", question }),
        );
      },
    });
    pi.registerTool({
      name: "inkbox_project_email",
      label: "Email a project result",
      description:
        "Request approval for the exact recipient, subject and plain-text email body, then send through the gateway.",
      parameters: {
        type: "object",
        properties: {
          recipient: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["recipient", "subject", "body"],
        additionalProperties: false,
      },
      async execute(_, { recipient, subject, body }, signal, _update, ctx) {
        const response = await action(ctx, signal, {
          kind: "email",
          recipient,
          subject,
          body,
        });
        if (response !== "sent")
          throw new Error("Email delivery was not confirmed.");
        return result("Email sent.");
      },
    });
  }
  if (!files.length) return;
  pi.registerTool({
    name: "inkbox_project_replace",
    label: "Edit granted file",
    description:
      "Replace a unique exact text passage in one owner-granted project file.",
    parameters: {
      type: "object",
      properties: {
        file,
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["file", "oldText", "newText"],
      additionalProperties: false,
    },
    async execute(_, { file, oldText, newText }, signal, _onUpdate, ctx) {
      if (
        typeof oldText !== "string" ||
        !oldText ||
        typeof newText !== "string" ||
        newText.includes("\0")
      )
        throw new Error("Invalid text replacement.");
      const { target, text, info } = await readTarget(file);
      const start = text.indexOf(oldText);
      if (start < 0 || text.indexOf(oldText, start + 1) !== -1)
        throw new Error("Passage is missing or not unique.");
      const updated =
        text.slice(0, start) + newText + text.slice(start + oldText.length);
      if (Buffer.byteLength(updated) > LIMIT)
        throw new Error("Updated file is too large.");
      if (confirmEdits) {
        const proposal = encodeEditProposal({ file, oldText, newText });
        if (
          ctx?.mode !== "rpc" ||
          (await ctx.ui.confirm(PROJECT_EDIT_TITLE, proposal, { signal })) !==
            true
        )
          throw new Error(
            "Exact edit was not approved. File unchanged. The request may have been denied, expired or undelivered; do not assume the sender declined.",
          );
      }
      signal?.throwIfAborted();
      const temp = join(dirname(target), ".inkbox-pi-edit-" + randomUUID());
      const fd = await open(temp, "wx", 0o600);
      try {
        await fd.writeFile(updated);
        await fd.chmod(info.mode & 0o777);
        await fd.sync();
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      } finally {
        await fd.close();
      }
      try {
        // Approval may have taken minutes. Verify the same contents and inode
        // are still in place, not just that the selected passage exists.
        if (confirmEdits && (await readTarget(file)).text !== text)
          throw new Error("File changed since it was read.");
        const current = await stat(target);
        if (
          current.dev !== info.dev ||
          current.ino !== info.ino ||
          current.ctimeMs !== info.ctimeMs ||
          (await realpath(target)) !== target
        ) {
          throw new Error("File changed since it was read.");
        }
        signal?.throwIfAborted();
        await rename(temp, target);
      } finally {
        await rm(temp, { force: true });
      }
      return result("File updated.");
    },
  });
}
