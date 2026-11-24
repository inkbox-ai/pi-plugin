import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--prod")) {
  throw new Error("Usage: ./publish.sh [--prod]");
}
const production = args.includes("--prod");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const sdk = manifest.dependencies["@inkbox/sdk"];
if (!/^\d+\.\d+\.\d+$/.test(sdk))
  throw new Error("Pin an exact published SDK version.");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (
  lock.version !== manifest.version ||
  lock.packages[""].version !== manifest.version ||
  lock.packages["node_modules/@inkbox/sdk"].version !== sdk
) {
  throw new Error("Release manifest and lockfile versions do not agree.");
}
const registry = "https://registry.npmjs.org/";
function npm(...args) {
  return JSON.parse(
    execFileSync("npm", [...args, "--json", "--registry", registry], {
      encoding: "utf8",
    }),
  );
}
if (npm("view", "@inkbox/sdk@" + sdk, "version") !== sdk) {
  throw new Error("Publish the matching Inkbox SDK before the Pi package.");
}
const folder = mkdtempSync(join(tmpdir(), "inkbox-pi-release-"));
try {
  const [pack] = npm("pack", "--ignore-scripts", "--pack-destination", folder);
  const files = new Set(pack.files.map((file) => file.path));
  for (const required of [
    ...manifest.pi.extensions,
    ...Object.values(manifest.bin),
    manifest.exports["./runtime"],
  ]) {
    if (!files.has(required.replace(/^\.\//, "")))
      throw new Error("Missing package file: " + required);
  }
  if (![...files].some((path) => /^skills\/.+\/SKILL\.md$/.test(path)))
    throw new Error("No packaged skills");
  if (
    pack.name !== manifest.name ||
    pack.version !== manifest.version ||
    !pack.integrity
  ) {
    throw new Error("Unexpected npm artifact");
  }
  const target = manifest.name + "@" + manifest.version;
  const result = spawnSync(
    "npm",
    ["view", target, "dist.integrity", "--json", "--registry", registry],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status === 0) {
    if (JSON.parse(result.stdout) !== pack.integrity)
      throw new Error(target + " already exists with different contents.");
    console.log(target + " is already published with the same contents.");
  } else {
    if (
      ![result.stdout, result.stderr].some((output) => {
        try {
          return JSON.parse(output).error?.code === "E404";
        } catch {
          return false;
        }
      })
    )
      throw new Error("Could not verify availability of " + target);
    execFileSync(
      "npm",
      [
        "publish",
        join(folder, pack.filename),
        "--registry",
        registry,
        "--access",
        "public",
        "--ignore-scripts",
        "--tag",
        "latest",
        ...(production ? [] : ["--dry-run"]),
      ],
      { stdio: "inherit" },
    );
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
