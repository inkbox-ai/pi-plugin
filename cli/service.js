import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { problem } from "./errors.js";
import { loadConfig, saveProfile, readProfile } from "./config.js";

import { modelEnvironment } from "./model-env.js";

const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const entry = fileURLToPath(new URL("../bin/inkbox-pi.js", import.meta.url));

const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function serviceFiles(home, accountHome = homedir()) {
  // Distinct profiles must never restart or disable each other's gateways.
  const suffix = createHash("sha256").update(home).digest("hex").slice(0, 16);
  const label = "ai.inkbox.pi." + suffix;
  const name = "inkbox-pi-" + suffix + ".service";
  return {
    name, label, unit: path.join(accountHome, ".config/systemd/user", name),
    loginPlist: path.join(accountHome, "Library/LaunchAgents", label + ".plist"),
    manualPlist: path.join(home, label + ".plist"),
  };
}

function write(file, data) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, data, { mode: 0o600 });
}

function unitQuote(value) {
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", () => "$$") + '"';
}

export function unitFile(node, bin, home) {
  if ([node, bin, home].some(v => /[\r\n\0]/.test(v))) throw problem("A service path contains a control character.");
  return [
    "[Unit]", "Description=Inkbox gateway for Pi", "After=network-online.target",
    "[Service]", "Type=simple",
    "ExecStart=" + [node, bin, "service-run", home].map(unitQuote).join(" "),
    "Restart=on-failure", "RestartSec=5", "[Install]", "WantedBy=default.target", "",
  ].join("\n");
}

function plist(label, home) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' +
    '<key>Label</key><string>' + xml(label) + '</string><key>ProgramArguments</key><array>' +
    [process.execPath, entry, "service-run", home].map(v => '<string>' + xml(v) + '</string>').join("") +
    '</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>' +
    '<key>StandardErrorPath</key><string>' + xml(path.join(home, "gateway.log")) + '</string></dict></plist>\n';
}

function invoke(bin, args, requireSuccess = true) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 10_000 });
  if (requireSuccess && result.status !== 0) throw problem("Service manager failed: " + bin + " " + args[0] + ". A logged-in user service session is required; use inkbox-pi run otherwise.");
  return result;
}

function queryService(config) {
  const files = serviceFiles(config.home);
  if (process.platform === "linux") {
    const pid = Number(invoke("systemctl", ["--user", "show", files.name, "-p", "MainPID", "--value"], false).stdout);
    return { pid, enabled: invoke("systemctl", ["--user", "is-enabled", files.name], false).stdout?.trim() === "enabled" };
  }
  if (process.platform === "darwin") {
    const result = invoke("launchctl", ["print", "gui/" + process.getuid() + "/" + files.label], false);
    return { pid: Number(result.stdout?.match(/^\s*pid = (\d+)$/m)?.[1]), enabled: existsSync(files.loginPlist) };
  }
  throw problem("Background services require macOS or Linux. Use inkbox-pi run.");
}

function isReady(config, pid, fingerprint) {
  if (!pid) return false;
  try {
    const [owner, loaded] = readFileSync(path.join(config.home, "gateway.ready"), "utf8").split("\n");
    return owner === String(pid) && (!fingerprint || loaded === fingerprint);
  }
  catch { return false; }
}

export function serviceStatus(config, fingerprint) {
  const { pid, enabled } = queryService(config);
  return { running: pid > 0, ready: isReady(config, pid, fingerprint), autostart: enabled };
}

// Copy only settings required by this profile, not an arbitrary caller's
// environment. Model credentials should be configured with Pi's own login.
function saveServiceSettings(config) {
  const { home, ...runtime } = config;
  const baseline = loadConfig({ INKBOX_PI_HOME: home });
  const overrides = Object.fromEntries(Object.entries(runtime)
    .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(baseline[key])));
  // A service with no saved profile still needs a stable working directory.
  overrides.projectDirectory = config.projectDirectory;
  const serviceDir = path.join(home, "service");
  const previous = readProfile(serviceDir);
  const sameOwner = previous.selectedIdentity === config.identity && previous.selectedOrigin === config.baseUrl;
  const modelEnv = modelEnvironment(process.env, sameOwner ? previous.modelEnv : undefined);
  const settings = {
    selectedIdentity: config.identity, selectedOrigin: config.baseUrl, modelEnv,
    overrides, profileIdentity: baseline.identity, profileOrigin: baseline.baseUrl,
    path: process.env.PATH, agentDir: process.env.PI_CODING_AGENT_DIR,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify([config, settings, process.execPath, entry, packageVersion])).digest("hex");
  saveProfile(serviceDir, { ...settings, fingerprint });
  return fingerprint;
}

export async function service(action, config) {
  const files = serviceFiles(config.home);
  const starting = ["start", "restart", "install"].includes(action);
  let fingerprint;
  if (starting) {
    if (!config.apiKey || !config.identity || !config.signingKey) throw problem("Run inkbox-pi setup before starting the gateway.");
    fingerprint = saveServiceSettings(config);
    if (action === "start") {
      const current = serviceStatus(config, fingerprint);
      if (current.ready) return;
      action = "restart";
    }
  }
  if (process.platform === "linux") {
    const systemctl = (...args) => invoke("systemctl", ["--user", ...args]);
    if (starting) {
      write(files.unit, unitFile(process.execPath, entry, config.home));
      systemctl("daemon-reload");
      if (action === "install") systemctl("enable", files.name);
      systemctl(action === "start" ? "start" : "restart", files.name);
    } else if (existsSync(files.unit)) {
      if (action === "stop") systemctl("stop", files.name);
      else {
        systemctl("disable", "--now", files.name);
        rmSync(files.unit);
        systemctl("daemon-reload");
      }
    }
  } else if (process.platform === "darwin") {
    const domain = "gui/" + process.getuid();
    const target = domain + "/" + files.label;
    const loaded = invoke("launchctl", ["print", target], false).status === 0;
    if (loaded && action !== "start") invoke("launchctl", ["bootout", target]);
    if (starting && (!loaded || action !== "start")) {
      const file = action === "install" || existsSync(files.loginPlist) ? files.loginPlist : files.manualPlist;
      write(file, plist(files.label, config.home));
      invoke("launchctl", ["bootstrap", domain, file]);
    } else if (action === "uninstall") {
      rmSync(files.loginPlist, { force: true });
      rmSync(files.manualPlist, { force: true });
    }
  } else throw problem("Background services require macOS or Linux. Use inkbox-pi run.");
  if (action === "uninstall") rmSync(path.join(config.home, "service/config.json"), { force: true });
  if (starting) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (serviceStatus(config, fingerprint).ready) return;
      await delay(400);
    }
    throw problem("Service requested but gateway not ready. Check inkbox-pi status and the service log.");
  }
}
