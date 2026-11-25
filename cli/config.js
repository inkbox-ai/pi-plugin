import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export function configHome(env = process.env) {
  return path.resolve(
    env.INKBOX_PI_HOME || path.join(env.HOME || homedir(), ".inkbox-pi"),
  );
}

export function readProfile(home) {
  try {
    const value = JSON.parse(
      readFileSync(path.join(home, "config.json"), "utf8"),
    );
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error("Invalid profile");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(
      "Cannot read Inkbox Pi config.json. Check the file and its permissions.",
    );
  }
}

export function saveProfile(home, data) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temp = path.join(home, ".config-" + randomUUID());
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temp, path.join(home, "config.json"));
  } finally {
    rmSync(temp, { force: true });
  }
}

export function normalizeOrigin(url) {
  const parsed = new URL(url);
  if (
    (parsed.protocol !== "https:" &&
      !(
        parsed.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      )) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Use an HTTPS API origin (or a loopback HTTP origin).");
  }
  return parsed.origin;
}

// The shared SDK profile uses `key = value` lines. Bind its key and signing
// secret to its origin/identity rather than independently mixing sources.
function readSharedProfile(accountHome) {
  let contents;
  try {
    contents = readFileSync(
      path.join(accountHome, ".inkbox", "config"),
      "utf8",
    );
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const profile = {};
  for (const line of contents.split("\n")) {
    const match = line.match(
      /^\s*(api_key|base_url|identity|signing_key)\s*=\s*(.*?)\s*$/,
    );
    if (match) profile[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return profile;
}

export function signingKeyDigest(key) {
  return createHash("sha256").update(key).digest("hex");
}

function optionalOrigin(value) {
  try {
    return normalizeOrigin(value || "https://inkbox.ai");
  } catch {
    return undefined;
  }
}

export function sharedSigningKey(baseUrl, identity, env = process.env) {
  const shared = readSharedProfile(env.HOME || homedir());
  if (
    identity &&
    (shared.identity || "").replace(/^@/, "") === identity &&
    optionalOrigin(shared.base_url) === baseUrl
  )
    return shared.signing_key;
}

export function loadConfig(env = process.env) {
  const home = configHome(env);
  const saved = readProfile(home);
  const shared = readSharedProfile(env.HOME || homedir());
  const sharedOrigin = optionalOrigin(shared.base_url);
  const sharedIdentity = (shared.identity || "").replace(/^@/, "");
  const baseUrl = normalizeOrigin(
    env.INKBOX_BASE_URL ||
      saved.baseUrl ||
      shared.base_url ||
      "https://inkbox.ai",
  );
  const sameOrigin =
    normalizeOrigin(saved.baseUrl || "https://inkbox.ai") === baseUrl;
  const identity = (
    env.INKBOX_IDENTITY ||
    env.INKBOX_AGENT_IDENTITY ||
    env.INKBOX_AGENT_HANDLE ||
    (sameOrigin && saved.identity) ||
    (sharedOrigin === baseUrl && sharedIdentity) ||
    ""
  ).replace(/^@/, "");
  const sharedMatches = baseUrl === sharedOrigin && identity === sharedIdentity;
  const sameIdentity = sameOrigin && identity === saved.identity;
  const signingCandidate =
    env.INKBOX_SIGNING_KEY ||
    (sameIdentity && saved.signingKey) ||
    (sharedMatches && sharedIdentity && shared.signing_key) ||
    "";
  const signingKey =
    signingCandidate &&
    sameIdentity &&
    saved.invalidSigningKeyDigest === signingKeyDigest(signingCandidate)
      ? ""
      : signingCandidate;
  const publicUrl =
    env.INKBOX_PI_PUBLIC_URL || (sameIdentity && saved.publicUrl) || undefined;
  const port = Number(
    env.INKBOX_PI_PORT || saved.port || (publicUrl ? 18793 : 0),
  );
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    (publicUrl && port === 0)
  ) {
    throw new Error(
      "Invalid INKBOX_PI_PORT. A fixed port is required with a public URL.",
    );
  }
  function listSetting(name, field) {
    const raw = env[name];
    const list =
      raw === undefined
        ? (sameIdentity && saved[field]) || []
        : raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    if (!Array.isArray(list) || list.some((v) => typeof v !== "string"))
      throw new Error("Expected a list of strings for " + field);
    return list;
  }
  const slackSetting =
    env.INKBOX_SLACK_ENABLED ?? (sameIdentity && saved.slackEnabled) ?? false;
  if (![true, false, "true", "false"].includes(slackSetting))
    throw new Error("Choose true or false for slackEnabled.");
  const slackEnabled = slackSetting === true || slackSetting === "true";
  const groupReplyMode =
    env.INKBOX_GROUP_REPLY_MODE ||
    (sameIdentity && saved.groupReplyMode) ||
    "auto";
  const companionResponseMode =
    env.INKBOX_COMPANION_RESPONSE_MODE ||
    (sameIdentity && saved.companionResponseMode) ||
    "safe";
  if (!["auto", "mention"].includes(groupReplyMode))
    throw new Error("Choose auto or mention for groupReplyMode.");
  if (!["safe", "relaxed"].includes(companionResponseMode))
    throw new Error("Choose safe or relaxed for companionResponseMode.");
  const memoriesSetting =
    env.INKBOX_CONTACT_MEMORIES_ENABLED ??
    (sameIdentity ? saved.contactMemories : undefined) ??
    true;
  if (![true, false, "true", "false"].includes(memoriesSetting))
    throw new Error("Choose true or false for contactMemories.");
  const permissionTimeoutS = Number(
    env.INKBOX_PERMISSION_TIMEOUT_S ||
      (sameIdentity && saved.permissionTimeoutS) ||
      600,
  );
  if (
    !Number.isInteger(permissionTimeoutS) ||
    permissionTimeoutS < 10 ||
    permissionTimeoutS > 1500
  )
    throw new Error("permissionTimeoutS must be between 10 and 1500 seconds.");
  return {
    home,
    baseUrl,
    identity,
    publicUrl,
    port,
    groupReplyMode,
    companionResponseMode,
    slackEnabled,
    contactMemories: memoriesSetting === true || memoriesSetting === "true",
    permissionTimeoutS,
    // Pi tools that run in a messaging turn without asking the conversation.
    autoAllowedTools:
      env.INKBOX_PI_AUTO_ALLOWED_TOOLS === undefined &&
      !(sameIdentity && saved.autoAllowedTools)
        ? undefined
        : listSetting("INKBOX_PI_AUTO_ALLOWED_TOOLS", "autoAllowedTools"),
    apiKey:
      env.INKBOX_API_KEY ||
      (sameIdentity && saved.apiKey) ||
      (sharedMatches && shared.api_key) ||
      "",
    signingKey,
    projectDirectory: path.resolve(
      env.INKBOX_PI_PROJECT_DIR || saved.projectDirectory || process.cwd(),
    ),
    piBin: env.INKBOX_PI_BIN || saved.piBin || "pi",
    tunnelName:
      env.INKBOX_PI_TUNNEL_NAME ||
      (sameIdentity && saved.tunnelName) ||
      identity,
    allowedSenders: listSetting("INKBOX_PI_ALLOWED_SENDERS", "allowedSenders"),
    tools: (sameIdentity && saved.tools) || {},
    outbound: (sameIdentity && saved.outbound) || {},
  };
}
