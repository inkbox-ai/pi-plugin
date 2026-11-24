import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { configHome, loadConfig, readProfile } from "./config.js";
import {
  configure,
  createClient,
  signingKeyReady,
  verifiedIdentity,
} from "./setup.js";
import { modelEnvironment } from "./model-env.js";
import { prompts } from "./prompts.js";
import { service, serviceStatus, servicePiCommand } from "./service.js";
import { problem } from "./errors.js";
import { checkPiModel } from "../gateway/preflight.js";

const HELP = `inkbox-pi — Inkbox for the Pi coding agent

  setup [--print | --replace-key]     Connect or create an identity and configure the gateway
  bootstrap --identity HANDLE [--base-url URL] [--project-dir DIR]
            [--api-key-stdin] [--rotate-signing-key] [--start-gateway]
  whoami              Show the connected identity and channel addresses
  doctor              Check the Pi binary, identity, signing key and gateway
  event EVENT_ID      Inspect the local state and any captured result for a webhook event
  run                 Run the inbound gateway in the foreground
  start|stop|restart   Manage the background gateway
  status              Show background gateway readiness and autostart state
  autostart install|uninstall|status
                      Enable, remove or inspect the login service
  uninstall           Remove the background service, preserving your profile

Log in to a model with Pi, or set INKBOX_PI_MODEL_ENV to a comma-separated
list of provider API-key variable names to keep in the private service profile.
`;

const CHECKLIST = `Connect the Pi extension with inkbox-pi setup in an interactive terminal.
For unattended setup use bootstrap --identity HANDLE --api-key-stdin.
Setup can create a new agent after email verification, or connect an existing one.
To reuse a configured webhook signing key, supply INKBOX_SIGNING_KEY.
Run inkbox-pi doctor, then inkbox-pi run (foreground) or inkbox-pi start (background).
Use inkbox-pi autostart install to restart the gateway at login.
`;

async function readKey() {
  let key = "";
  for await (const chunk of process.stdin) {
    key += chunk;
    if (key.length > 16384)
      throw problem("Expected only the API key on standard input.");
  }
  return key.trim();
}

function hostVersion(config) {
  const result = spawnSync(config.piBin, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0
    ? result.stdout.trim().split(/\r?\n/)[0]
    : undefined;
}

function printIdentity(id) {
  console.log("Identity: @" + id.agentHandle);
  console.log("Email: " + (id.emailAddress || "not assigned"));
  console.log("SMS: " + (id.phoneNumber?.number || "not assigned"));
  console.log("iMessage: " + (id.imessageEnabled ? "enabled" : "not enabled"));
}

async function doctor(config) {
  const version = hostVersion(config);
  console.log(
    "Pi: " + (version || "not available (check INKBOX_PI_BIN and PATH)"),
  );
  let modelReady = false;
  if (version) {
    try {
      await checkPiModel(config);
      modelReady = true;
      console.log("Pi model: configured");
    } catch (error) {
      console.log("Pi model: " + (error.operatorMessage || "not available"));
    }
  }
  if (!config.apiKey) {
    console.log("Identity: missing API key; run inkbox-pi setup");
    return 1;
  }
  const identity = await verifiedIdentity(
    createClient(config.apiKey, config.baseUrl),
    config.identity,
  );
  printIdentity(identity);
  const { inspectJournal } = await import("../gateway/journal.js");
  console.log(
    "Local gateway journal: " +
      JSON.stringify(inspectJournal(config, identity)),
  );
  const ready = await signingKeyReady(config, identity);
  console.log(
    "Webhook signing key: " +
      (ready ? "configured" : "missing or changed; rerun setup"),
  );
  if (process.platform === "linux" || process.platform === "darwin") {
    console.log("Background gateway: " + JSON.stringify(serviceStatus(config)));
  }
  return version && modelReady && ready ? 0 : 1;
}

async function foreground(config, managed) {
  const { startGateway } = await import("../gateway/index.js");
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  process.once("SIGTERM", finish);
  process.once("SIGINT", finish);
  let gateway;
  const marker = String(process.pid) + "\n" + (managed || "");
  const readyFile = path.join(config.home, "gateway.ready");
  try {
    gateway = await startGateway(config);
    if (managed) {
      mkdirSync(config.home, { recursive: true, mode: 0o700 });
      writeFileSync(readyFile, marker, { mode: 0o600 });
    }
    console.log(
      "Gateway ready" + (gateway.publicUrl ? ": " + gateway.publicUrl : ""),
    );
    await Promise.race([done, gateway.failed]);
  } finally {
    try {
      if (managed && gateway && readFileSync(readyFile, "utf8") === marker)
        rmSync(readyFile);
    } finally {
      await gateway?.close();
      process.removeListener("SIGTERM", finish);
      process.removeListener("SIGINT", finish);
    }
  }
  return 0;
}

export async function main(argv) {
  const [command, ...args] = argv;
  if (!command || ["help", "-h", "--help"].includes(command)) {
    console.log(HELP);
    return 0;
  }
  if (command === "service-run") {
    if (args.length !== 1 || !path.isAbsolute(args[0]))
      throw problem("Invalid service profile.");
    const home = args[0];
    const settings = readProfile(path.join(home, "service"));
    if (!settings.overrides)
      throw problem("Service profile not found; rerun inkbox-pi start.");
    const allowedModelEnv = modelEnvironment({
      ...settings.modelEnv,
      INKBOX_PI_MODEL_ENV: Object.keys(settings.modelEnv || {}).join(","),
    });
    Object.assign(process.env, allowedModelEnv);
    if (settings.path) process.env.PATH = settings.path;
    if (settings.agentDir) process.env.PI_CODING_AGENT_DIR = settings.agentDir;
    const baseline = loadConfig({ INKBOX_PI_HOME: home });
    if (
      settings.profileIdentity !== baseline.identity ||
      settings.profileOrigin !== baseline.baseUrl
    ) {
      throw problem(
        "Profile identity changed. Run inkbox-pi restart to select the new profile.",
      );
    }
    return foreground(
      {
        ...baseline,
        ...settings.overrides,
        ...(settings.piPaths
          ? { piBin: servicePiCommand(settings.piPaths) }
          : {}),
        home,
      },
      settings.fingerprint || "legacy",
    );
  }
  const managementOnly =
    ["stop", "uninstall", "status"].includes(command) ||
    (command === "autostart" &&
      [undefined, "status", "uninstall"].includes(args[0]));
  const config = managementOnly ? { home: configHome() } : loadConfig();
  if (command === "bootstrap" || command === "setup") {
    const schema =
      command === "bootstrap"
        ? {
            identity: { type: "string" },
            "base-url": { type: "string" },
            "project-dir": { type: "string" },
            "api-key-stdin": { type: "boolean" },
            "rotate-signing-key": { type: "boolean" },
            "start-gateway": { type: "boolean" },
          }
        : { print: { type: "boolean" }, "replace-key": { type: "boolean" } };
    const { values } = parseArgs({ args, options: schema });
    if (
      command === "setup" &&
      (values.print || !process.stdin.isTTY || !process.stdout.isTTY)
    ) {
      console.log(CHECKLIST);
      return 0;
    }
    const io = command === "setup" ? prompts() : undefined;
    try {
      const selected = await configure(
        config,
        {
          identity: values.identity,
          baseUrl: values["base-url"],
          projectDir: values["project-dir"],
          key: values["api-key-stdin"]
            ? await readKey()
            : process.env.INKBOX_API_KEY,
          signingKey: process.env.INKBOX_SIGNING_KEY,
          rotate: values["rotate-signing-key"],
          replaceKey: values["replace-key"],
        },
        io,
      );
      if (!selected.ready) {
        console.log(
          JSON.stringify({
            status: "requires_human",
            identity: selected.identity,
            action:
              "Provide the existing INKBOX_SIGNING_KEY or use bootstrap --rotate-signing-key to replace it.",
          }),
        );
        return 2;
      }
      if (io) console.log("Setup complete: @" + selected.identity);
      // Consume the scoped credential we just persisted, not the admin key
      // used as input to bootstrap or a previous profile's key from the shell.
      const saved = loadConfig({
        ...process.env,
        INKBOX_BASE_URL: "",
        INKBOX_API_KEY: "",
        INKBOX_IDENTITY: "",
        INKBOX_AGENT_IDENTITY: "",
        INKBOX_AGENT_HANDLE: "",
        INKBOX_SIGNING_KEY: "",
      });
      let started = false;
      if (
        values["start-gateway"] ||
        (io &&
          (await io.confirm("Start the gateway and keep it running at login?")))
      ) {
        await service(io ? "install" : "restart", saved);
        started = true;
      }
      if (!io)
        console.log(
          JSON.stringify({
            status: "configured",
            identity: selected.identity,
            gatewayStarted: started,
          }),
        );
      return 0;
    } finally {
      io?.close();
    }
  }
  if (
    (command === "autostart" &&
      (!args.length || (args.length === 1 && args[0] === "status"))) ||
    (command === "status" && !args.length)
  ) {
    const status = serviceStatus(config);
    console.log(JSON.stringify(status));
    return status.ready ? 0 : 3;
  }
  if (
    command === "autostart" &&
    args.length === 1 &&
    ["install", "uninstall"].includes(args[0])
  ) {
    if (args[0] === "install")
      await verifiedIdentity(
        createClient(config.apiKey, config.baseUrl),
        config.identity,
      );
    await service(args[0], config);
    return 0;
  }
  if (command === "event") {
    if (args.length !== 1 || !args[0] || args[0].length > 256)
      throw problem("Usage: inkbox-pi event EVENT_ID");
    const identity = await verifiedIdentity(
      createClient(config.apiKey, config.baseUrl),
      config.identity,
    );
    const { inspectJournal } = await import("../gateway/journal.js");
    const snapshot = inspectJournal(config, identity, args[0]);
    console.log(JSON.stringify(snapshot));
    return snapshot.state === "unknown" ? 3 : 0;
  }
  if (args.length) throw problem("Unexpected arguments. Run inkbox-pi help.");
  switch (command) {
    case "run":
      return foreground(config, false);
    case "start":
    case "restart":
      await verifiedIdentity(
        createClient(config.apiKey, config.baseUrl),
        config.identity,
      );
      await service(command, config);
      return 0;
    case "uninstall":
    case "stop":
      await service(command, config);
      return 0;
    case "doctor":
      return doctor(config);
    case "whoami":
      printIdentity(
        await verifiedIdentity(
          createClient(config.apiKey, config.baseUrl),
          config.identity,
        ),
      );
      return 0;
    default:
      throw problem("Unknown command. Run inkbox-pi help.");
  }
}
