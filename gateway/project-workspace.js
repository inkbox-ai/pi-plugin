import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, extname } from "node:path";
import { promisify } from "node:util";

export const FILE_LIMIT = 256 * 1024;
const git = promisify(execFile);

function safePath(name) {
  return (
    typeof name === "string" &&
    !isAbsolute(name) &&
    !/[\\\x00-\x1f\x7f]/.test(name) &&
    name.split("/").every((part) => part && !part.startsWith("."))
  );
}

// Workspace opt-in extends *reads* to tracked source code only. Nothing here
// expands the separate list accepted by the edit tool.
function sourceFile(name) {
  if (
    !safePath(name) ||
    /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|secrets?|credentials?)(?:\/|$)/i.test(
      name,
    )
  )
    return false;
  if (
    /(?:^|[\/._-])(?:private|secrets?|credentials?|tokens?|passwords?|keyfile|keystore)(?:[\/._-]|$)/i.test(
      name,
    )
  )
    return false;
  if (
    /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|google-services\.json|service[-_]?account[^/]*\.json|client[-_]?secret[^/]*\.json)$/i.test(
      name,
    )
  )
    return false;
  return (
    /^(?:\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|scala|cs|c|cc|cpp|h|hpp|css|scss|html|sql|sh|md|toml|json|ya?ml))$/i.test(
      extname(name),
    ) ||
    /(?:^|\/)(?:package\.json|tsconfig\.json|go\.mod|go\.sum|Makefile)$/.test(
      name,
    )
  );
}

export async function readableFiles(root, granted, workspace, signal) {
  if (!workspace) return new Set(granted);
  // Ignore global Git configuration and never invoke repository hooks or filters.
  const { stdout } = await git(
    "/usr/bin/git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "--stage",
      "-z",
      "--",
      ".",
    ],
    {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    },
  );
  const files = new Set(granted);
  for (const entry of stdout.split("\0")) {
    // Exclude tracked symlinks, submodules and conflicted index entries.
    const match = /^100(?:644|755) [a-f0-9]+ 0\t(.+)$/u.exec(entry);
    if (match && sourceFile(match[1])) files.add(match[1]);
  }
  return files;
}

export async function readProjectFile(root, name, permitted) {
  if (!permitted.has(name) || !safePath(name))
    throw new Error("Not a granted project file.");
  const target = join(await realpath(root), name);
  if ((await realpath(target)) !== target)
    throw new Error("Symbolic links cannot be used as project grants.");
  const fd = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > FILE_LIMIT)
      throw new Error("Expected one small regular text file.");
    // Bound even a file that grows after fstat.
    const buffer = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await fd.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    const current = await stat(target);
    if (
      size !== info.size ||
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.ctimeMs !== info.ctimeMs ||
      current.nlink !== 1 ||
      (await realpath(target)) !== target
    )
      throw new Error("File changed since it was read.");
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(buffer.subarray(0, size));
    if (text.includes("\0")) throw new Error("Expected a text file.");
    return { target, text, info };
  } finally {
    await fd.close();
  }
}
