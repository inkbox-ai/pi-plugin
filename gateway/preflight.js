import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { hostProblem } from "./diagnostics.js";

const exec = promisify(execFile);
export const restricted = [
  "--no-extensions",
  "--no-skills",
  "--no-mcp",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-themes",
  "--no-approve",
];
export function piEnvironment() {
  const env = { ...process.env, NO_COLOR: "1" };
  for (const name of Object.keys(env))
    if (name.startsWith("INKBOX_")) delete env[name];
  return env;
}

// Resolve the *selected* model in an isolated session. Listing all available
// models is insufficient and sending a test prompt would incur model usage.
async function selectedProvider(binary, cwd, env) {
  const child = spawn(
    binary,
    ["--mode", "rpc", "--no-session", "--no-tools", ...restricted],
    { cwd, env, stdio: ["pipe", "pipe", "ignore"] },
  );
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 15_000);
  let timedOut = false,
    buffer = "";
  const response = new Promise((resolve, reject) => {
    child.once("error", () => reject(hostProblem("pi-binary")));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.id !== "inkbox-model" || record.type !== "response")
          continue;
        const model = record.data?.model;
        if (
          !record.success ||
          !model?.id ||
          typeof model.provider !== "string" ||
          !model.provider
        )
          reject(hostProblem("pi-model"));
        else resolve(model.provider);
      }
      if (buffer.length > 1024 * 1024) reject(hostProblem("pi-protocol"));
    });
    child.once("close", () =>
      reject(hostProblem(timedOut ? "pi-timeout" : "pi-model")),
    );
    child.stdin.write('{"id":"inkbox-model","type":"get_state"}\n');
  });
  try {
    return await response;
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    child.kill("SIGKILL");
  }
}

export async function checkPiModel(config) {
  const binary = config.piBin || "pi",
    env = piEnvironment(),
    cwd = config.projectDirectory;
  const provider = await selectedProvider(binary, cwd, env);
  try {
    // Pi prints only readiness; never request the credential itself.
    const { stdout } = await exec(
      binary,
      ["auth", "check", "--provider", provider, "--json", "--no-refresh"],
      {
        cwd,
        env,
        timeout: 15_000,
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024,
      },
    );
    if (JSON.parse(stdout).status !== "ready") throw hostProblem("pi-auth");
  } catch (error) {
    throw hostProblem(error.killed ? "pi-timeout" : "pi-auth");
  }
}
