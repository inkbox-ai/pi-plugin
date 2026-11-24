// The gateway runs the operator's reviewed argv against a disposable snapshot,
// never in the live checkout or the Pi process holding model credentials.
import { fork, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeProjectAction } from "./pi-rpc.js";
import { readableFiles, readProjectFile } from "./project-workspace.js";

const DEADLINE = 30_000;
const MAX_OUTPUT = 8192;
const systemPath = "/usr/bin:/bin";
const file = fileURLToPath(import.meta.url);

async function snapshot(config, root, signal) {
  const granted = new Set(config.projectFiles ?? []);
  const files = await readableFiles(
    config.projectDirectory,
    granted,
    config.projectReadWorkspace,
    signal,
  );
  let total = 0;
  if (files.size > 2000)
    throw new Error(
      "Test snapshot exceeds 2000 files; narrow the project scope.",
    );
  for (const name of files) {
    signal.throwIfAborted();
    let source;
    try {
      source = await readProjectFile(config.projectDirectory, name, files);
    } catch {
      throw new Error("Cannot snapshot selected test input: " + name);
    }
    total += Buffer.byteLength(source.text);
    if (total > 32 * 1024 * 1024)
      throw new Error("Test snapshot exceeds 32 MiB.");
    const dest = join(root, name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, source.text, {
      mode: source.info.mode & 0o111 ? 0o700 : 0o600,
      flag: "wx",
    });
  }
  return files.size;
}

async function sandbox(root, config) {
  const command = config.projectTestCommand;
  const env = { PATH: systemPath, LANG: "C", HOME: "/tmp", TMPDIR: "/tmp" };
  if (process.platform === "linux") {
    const binary = "/usr/bin/bwrap";
    if (!existsSync(binary))
      throw new Error("Project tests require bubblewrap (bwrap) on Linux.");
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--size",
      "67108864",
      "--tmpfs",
      "/tmp",
      "--size",
      "67108864",
      "--tmpfs",
      "/workspace",
      "--ro-bind",
      root,
      "/source",
    ];
    for (const path of [
      "/usr/bin",
      "/usr/lib",
      "/usr/lib64",
      "/usr/share/nodejs",
      "/bin",
      "/lib",
      "/lib64",
    ])
      if (existsSync(path)) args.push("--ro-bind", path, path);
    args.push(
      "--dir",
      "/toolchain/bin",
      "--ro-bind",
      process.execPath,
      "/toolchain/bin/node",
    );
    const npm = join(dirname(process.execPath), "../lib/node_modules/npm");
    if (existsSync(join(npm, "bin/npm-cli.js")))
      args.push(
        "--ro-bind",
        npm,
        "/toolchain/lib/node_modules/npm",
        "--symlink",
        "../lib/node_modules/npm/bin/npm-cli.js",
        "/toolchain/bin/npm",
      );
    if (config.projectReadWorkspace) {
      const modules = join(
        await realpath(config.projectDirectory),
        "node_modules",
      );
      if (existsSync(modules)) {
        if ((await realpath(modules)) !== modules)
          throw new Error(
            "Linked project dependency directories are not supported.",
          );
        args.push("--ro-bind", modules, "/workspace/node_modules");
      }
    }
    args.push(
      "--chdir",
      "/workspace",
      "--",
      "/bin/sh",
      "-c",
      'cp -R /source/. /workspace && exec "$@"',
      "inkbox-test",
      ...command,
    );
    env.PATH = "/toolchain/bin:" + systemPath;
    return { binary, args, env };
  }
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    // No fork in the Seatbelt profile: a test cannot daemonize and survive
    // cancellation. Use a single-process test runner (e.g. node <test.js>).
    const system = [
      "/System/Library",
      "/System/Volumes/Preboot/Cryptexes",
      "/usr/bin",
      "/usr/lib",
      "/bin",
      "/Library/Apple/System",
    ];
    const read = system
      .map((s) => "(subpath " + JSON.stringify(s) + ")")
      .join(" ");
    const dir = "(subpath " + JSON.stringify(root) + ")";
    const node = "(literal " + JSON.stringify(process.execPath) + ")";
    const profile =
      "(version 1)(deny default)(allow process-exec sysctl-read)" +
      '(deny sysctl-read (sysctl-name-prefix "kern.proc"))' +
      // libignition enumerates the root mount at process startup on macOS 26.
      // This literal permits its directory listing, not reads of descendants.
      '(allow file-read* (literal "/"))' +
      "(allow file-map-executable " +
      read +
      " " +
      node +
      ")" +
      "(allow file-read* " +
      read +
      " " +
      dir +
      " " +
      node +
      ' (literal "/dev/null") (literal "/dev/urandom"))' +
      "(allow file-write* " +
      dir +
      ' (literal "/dev/null"))';
    const argv =
      command[0] === "node" ? [process.execPath, ...command.slice(1)] : command;
    return {
      binary: "/usr/bin/sandbox-exec",
      args: ["-p", profile, ...argv],
      env: { ...env, HOME: root, TMPDIR: root },
    };
  }
  throw new Error(
    "No supported project test sandbox (Linux bubblewrap or macOS sandbox-exec).",
  );
}

// An IPC disconnect is also delivered on abrupt gateway process death. This
// supervisor owns the snapshot, deadline and process group independently.
async function supervise(config) {
  const life = new AbortController();
  const cancel = () => life.abort();
  process.once("disconnect", cancel);
  process.once("message", cancel);
  if (!process.connected) cancel();
  const timeout = setTimeout(cancel, DEADLINE);
  let root;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "inkbox-pi-test-")));
    const fileCount = await snapshot(config, root, life.signal);
    life.signal.throwIfAborted();
    const { binary, args, env } = await sandbox(root, config);
    return await new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: root,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = Buffer.alloc(0),
        truncated = false;
      const kill = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      };
      life.signal.addEventListener("abort", kill, { once: true });
      if (life.signal.aborted) kill();
      function collect(chunk) {
        const remaining = MAX_OUTPUT - output.length;
        if (remaining > 0)
          output = Buffer.concat([output, chunk.subarray(0, remaining)]);
        if (chunk.length > remaining) truncated = true;
      }
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        life.signal.removeEventListener("abort", kill);
        if (life.signal.aborted)
          return reject(new Error("Project test cancelled or timed out."));
        resolve(
          "Project test " +
            (code === null ? "signal " + signal : "exit " + code) +
            " (filtered snapshot: " +
            fileCount +
            " files)\n" +
            output.toString("utf8") +
            (truncated ? "\n[Output truncated.]" : ""),
        );
      });
    });
  } finally {
    clearTimeout(timeout);
    process.off("disconnect", cancel);
    process.off("message", cancel);
    if (root) await rm(root, { force: true, recursive: true });
  }
}

export async function runProjectTest(config, signal) {
  encodeProjectAction({ kind: "test", command: config.projectTestCommand });
  signal.throwIfAborted();
  const child = fork(file, ["--project-test-supervisor"], {
    env: { PATH: systemPath, LANG: "C" },
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return await new Promise((resolve, reject) => {
    let result;
    function abort() {
      if (child.connected) child.disconnect();
    }
    const finish = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    child.once("message", (reply) => {
      result = reply;
    });
    child.once("error", (err) => {
      finish();
      reject(err);
    });
    child.once("exit", () => {
      finish();
      if (signal.aborted) reject(signal.reason);
      else if (typeof result?.text === "string") resolve(result.text);
      else
        reject(new Error(result?.error || "Project test supervisor failed."));
    });
    child.send(
      {
        projectDirectory: config.projectDirectory,
        projectFiles: config.projectFiles,
        projectReadWorkspace: config.projectReadWorkspace,
        projectTestCommand: config.projectTestCommand,
      },
      (error) => {
        if (error) abort();
      },
    );
    if (signal.aborted) abort();
  });
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url &&
  process.argv[2] === "--project-test-supervisor" &&
  process.send
) {
  process.once("message", async (config) => {
    let reply;
    try {
      reply = { text: await supervise(config) };
    } catch (error) {
      reply = { error: error.message };
    }
    if (process.connected)
      process.send(reply, () => {
        if (process.connected) process.disconnect();
      });
  });
}
