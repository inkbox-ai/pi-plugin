// Load the actual packed artifact, not a source checkout with dev dependencies.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  createReadStream,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const root = mkdtempSync(join(tmpdir(), "inkbox-pi-smoke-"));
const pi = resolve("node_modules/.bin/pi");
const env = {
  ...process.env,
  HOME: root,
  PI_CODING_AGENT_DIR: join(root, "agent"),
  PI_OFFLINE: "1",
};
let child, registry;
try {
  const [artifact] = JSON.parse(
    execFileSync("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      root,
    ]),
  );
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  // Emulate the package's first public npm release without publishing anything.
  // All other dependencies are fetched normally from the public registry.
  registry = createServer((req, res) => {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (pathname === "/plugin.tgz") {
      createReadStream(join(root, artifact.filename)).pipe(res);
      return;
    }
    if (pathname === "/@inkbox/pi-plugin") {
      const dist = {
        integrity: artifact.integrity,
        shasum: artifact.shasum,
        tarball: "http://127.0.0.1:" + registry.address().port + "/plugin.tgz",
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: manifest.name,
          "dist-tags": { latest: manifest.version },
          versions: { [manifest.version]: { ...manifest, dist } },
        }),
      );
      return;
    }
    res.writeHead(302, { Location: "https://registry.npmjs.org" + req.url });
    res.end();
  });
  registry.listen(0, "127.0.0.1");
  await once(registry, "listening");
  const npmrc = join(root, ".npmrc");
  writeFileSync(
    npmrc,
    "@inkbox:registry=http://127.0.0.1:" + registry.address().port + "/\n",
  );
  Object.assign(env, {
    NPM_CONFIG_USERCONFIG: npmrc,
    INKBOX_PI_BIN: pi,
    INKBOX_PI_BIN_DIR: join(root, "bin"),
  });
  await promisify(execFile)("bash", [resolve("install.sh"), "--no-setup"], {
    cwd: workspace,
    env,
    timeout: 90_000,
  });
  const help = await promisify(execFile)(
    join(root, "bin/inkbox-pi"),
    ["help"],
    { cwd: workspace, env },
  );
  assert.match(help.stdout, /bootstrap/);
  // The gateway runs in plain Node, without the extension loader Pi supplies.
  await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", 'await import("@inkbox/pi-plugin/runtime")'],
    { cwd: join(env.PI_CODING_AGENT_DIR, "npm"), env },
  );
  child = spawn(pi, ["--mode", "rpc", "--no-session"], {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const lines = createInterface({ input: child.stdout });
    child.stdin.write(
      JSON.stringify({ id: "catalog-smoke", type: "get_commands" }) + "\n",
    );
    let commands;
    for await (const line of lines) {
      const response = JSON.parse(line);
      if (response.type !== "response" || response.id !== "catalog-smoke")
        continue;
      assert.equal(response.success, true);
      commands = response.data.commands;
      break;
    }
    assert.ok(
      commands?.some(
        (command) =>
          command.name === "inkbox-status" && command.source === "extension",
      ),
      "Installed extension must register the status command",
    );
    assert.ok(
      commands.some(
        (command) =>
          command.source === "skill" &&
          command.name.startsWith("skill:inkbox-"),
      ),
      "Installed package must expose its Inkbox skills",
    );
  } finally {
    child.stdin.end();
    child.kill();
    await exited;
    clearTimeout(timeout);
  }
} finally {
  if (registry?.listening) {
    registry.closeAllConnections();
    await new Promise((resolve) => registry.close(resolve));
  }
  rmSync(root, { recursive: true, force: true });
}
