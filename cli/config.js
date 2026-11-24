import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function configHome(env = process.env) {
  return path.resolve(env.INKBOX_PI_HOME || path.join(env.HOME || homedir(), ".inkbox-pi"));
}

export function readProfile(home) {
  try {
    const value = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Invalid profile");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Cannot read Inkbox Pi config.json. Check the file and its permissions.");
  }
}

export function saveProfile(home, data) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temp = path.join(home, ".config-" + randomUUID());
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temp, path.join(home, "config.json"));
  } finally {
    rmSync(temp, { force: true });
  }
}

export function normalizeOrigin(url) {
  const parsed = new URL(url);
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)))
      || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Use an HTTPS API origin (or a loopback HTTP origin).");
  }
  return parsed.origin;
}

export function loadConfig(env = process.env) {
  const home = configHome(env);
  const saved = readProfile(home);
  const baseUrl = normalizeOrigin(env.INKBOX_BASE_URL || saved.baseUrl || "https://inkbox.ai");
  const sameOrigin = normalizeOrigin(saved.baseUrl || "https://inkbox.ai") === baseUrl;
  const identity = (env.INKBOX_IDENTITY || (sameOrigin && saved.identity) || "").replace(/^@/, "");
  const sameIdentity = sameOrigin && identity === saved.identity;
  const publicUrl = env.INKBOX_PI_PUBLIC_URL || (sameIdentity && saved.publicUrl) || undefined;
  const port = Number(env.INKBOX_PI_PORT || saved.port || (publicUrl ? 18793 : 0));
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (publicUrl && port === 0)) {
    throw new Error("Invalid INKBOX_PI_PORT. A fixed port is required with a public URL.");
  }
  function listSetting(name, field) {
    const raw = env[name];
    const list = raw === undefined ? ((sameIdentity && saved[field]) || []) : raw.split(",").map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(list) || list.some(v => typeof v !== "string")) throw new Error("Expected a list of strings for " + field);
    return list;
  }
  return {
    home, baseUrl, identity, publicUrl, port,
    trustedAgentIds: listSetting("INKBOX_PI_TRUSTED_AGENT_IDS", "trustedAgentIds"),
    projectFiles: listSetting("INKBOX_PI_PROJECT_FILES", "projectFiles"),
    apiKey: env.INKBOX_API_KEY || (sameIdentity && saved.apiKey) || "",
    signingKey: env.INKBOX_SIGNING_KEY || (sameIdentity && saved.signingKey) || "",
    projectDirectory: path.resolve(env.INKBOX_PI_PROJECT_DIR || saved.projectDirectory || process.cwd()),
    piBin: env.INKBOX_PI_BIN || saved.piBin || "pi",
    tunnelName: env.INKBOX_PI_TUNNEL_NAME || (sameIdentity && saved.tunnelName) || identity,
    allowedSenders: listSetting("INKBOX_PI_ALLOWED_SENDERS", "allowedSenders"),
    tools: (sameIdentity && saved.tools) || {},
    outbound: (sameIdentity && saved.outbound) || {},
  };
}
