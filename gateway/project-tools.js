import { constants } from "node:fs";
import { open, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { encodeEditProposal, PROJECT_EDIT_TITLE } from "./pi-rpc.js";

const LIMIT = 256 * 1024;
const result = (text) => ({ content: [{ type: "text", text }], details: {} });

export default function register(pi) {
  const files = JSON.parse(process.env.INKBOX_PI_GRANTED_FILES ?? "[]");
  const confirmEdits = process.env.INKBOX_PI_CONFIRM_EDITS === "1";
  if (!Array.isArray(files) || !files.length) return;
  async function readTarget(name) {
    const root = await realpath(process.cwd());
    if (
      !files.includes(name) ||
      isAbsolute(name) ||
      name.split(/[\\/]/).some((part) => !part || part.startsWith("."))
    ) {
      throw new Error("Not a granted project file.");
    }
    const target = join(root, name);
    if ((await realpath(target)) !== target)
      throw new Error("Symbolic links cannot be used as project grants.");
    const fd = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > LIMIT)
        throw new Error("Expected one small regular text file.");
      const bytes = await fd.readFile();
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      if (text.includes("\0")) throw new Error("Expected a text file.");
      return { target, text, info };
    } finally {
      await fd.close();
    }
  }
  const file = { type: "string", enum: files };
  pi.registerTool({
    name: "inkbox_project_read",
    label: "Read granted file",
    description: "Read an owner-granted project file.",
    parameters: {
      type: "object",
      properties: { file },
      required: ["file"],
      additionalProperties: false,
    },
    async execute(_, args) {
      return result((await readTarget(args.file)).text);
    },
  });
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
