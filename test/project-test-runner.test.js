import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readableFiles,
  readProjectFile,
} from "../gateway/project-workspace.js";
import { runProjectTest } from "../gateway/project-test.js";

async function checkout(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-test-project-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

test("workspace reads/search candidates exclude untracked and sensitive paths; symlinks cannot resolve grants elsewhere", async (t) => {
  const dir = await checkout(t);
  for (const name of [
    "source.js",
    "passwords.py",
    "secrets.toml",
    ".env",
    "untracked.js",
  ])
    await writeFile(join(dir, name), name);
  await symlink("untracked.js", join(dir, "linked.js"));
  execFileSync(
    "git",
    ["add", "source.js", "passwords.py", "secrets.toml", ".env", "linked.js"],
    { cwd: dir },
  );
  const files = await readableFiles(dir, [], true);
  assert.deepEqual([...files].sort(), ["source.js"]);
  assert.equal(
    (await readProjectFile(dir, "source.js", files)).text,
    "source.js",
  );
  for (const name of [
    "../source.js",
    "linked.js",
    "untracked.js",
    ".env",
    "secrets.toml",
  ]) {
    await assert.rejects(readProjectFile(dir, name, files));
  }
});

test(
  "approved npm test uses installed dependency and tracked code, without credentials or mutating live project",
  {
    skip: process.platform !== "linux",
  },
  async (t) => {
    const dir = await checkout(t);
    const pkg = {
      name: "sandbox-test",
      version: "1.0.0",
      scripts: { test: "node checks.cjs" },
    };
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
    await writeFile(
      join(dir, "checks.cjs"),
      `
    const assert = require("node:assert/strict"), fs = require("node:fs");
    assert.equal(require("fixture-installed-dependency"),42);
    assert.equal(require("./fixture.json").expected,require("fixture-installed-dependency"));
    assert.equal(fs.readFileSync("settings.yaml","utf8"),"target: 42");
    assert.equal(fs.existsSync("service-account-key.json"),false);
    assert.equal(process.env.INKBOX_PI_SENTINEL,undefined);
    assert.equal(fs.existsSync(".env"),false);
    assert.equal(fs.existsSync(".git"),false);
    fs.writeFileSync("checks.cjs","changed inside snapshot");
    console.log("used installed dependency");
  `,
    );
    await writeFile(join(dir, ".env"), "not for tests");
    await writeFile(
      join(dir, "fixture.json"),
      JSON.stringify({ expected: 42 }),
    );
    await writeFile(join(dir, "settings.yaml"), "target: 42");
    await writeFile(
      join(dir, "service-account-key.json"),
      '{"private_key":"not for tests"}',
    );
    const dep = join(dir, "node_modules", "fixture-installed-dependency");
    await mkdir(dep, { recursive: true });
    await writeFile(join(dep, "index.js"), "module.exports=42;");
    execFileSync(
      "git",
      [
        "add",
        "package.json",
        "checks.cjs",
        ".env",
        "fixture.json",
        "settings.yaml",
        "service-account-key.json",
      ],
      {
        cwd: dir,
      },
    );
    const old = process.env.INKBOX_PI_SENTINEL;
    t.after(() => {
      if (old === undefined) delete process.env.INKBOX_PI_SENTINEL;
      else process.env.INKBOX_PI_SENTINEL = old;
    });
    process.env.INKBOX_PI_SENTINEL = "should not inherit";
    const output = await runProjectTest(
      {
        projectDirectory: dir,
        projectReadWorkspace: true,
        projectTestCommand: ["npm", "test"],
      },
      new AbortController().signal,
    );
    assert.match(output, /Project test exit 0/);
    assert.match(output, /filtered snapshot: 4 files/);
    assert.match(output, /used installed dependency/);
    await rm(join(dir, "fixture.json"));
    await assert.rejects(
      runProjectTest(
        {
          projectDirectory: dir,
          projectReadWorkspace: true,
          projectTestCommand: ["npm", "test"],
        },
        new AbortController().signal,
      ),
      /Cannot snapshot selected test input: fixture.json/,
    );
    assert.match(await readFile(join(dir, "checks.cjs"), "utf8"), /require/);
  },
);

test(
  "sandbox test result bounds stdout and cancellation terminates the supervisor",
  {
    skip: !["linux", "darwin"].includes(process.platform),
    timeout: 20_000,
  },
  async (t) => {
    const dir = await checkout(t);
    const run = (source, signal) =>
      runProjectTest(
        {
          projectDirectory: dir,
          projectFiles: [],
          projectTestCommand: ["node", "-e", source],
        },
        signal,
      );
    const output = await run(
      'console.log("x".repeat(14000))',
      new AbortController().signal,
    );
    assert.match(output, /exit 0/);
    assert.match(output, /Output truncated/);
    assert.ok(output.length < 8500);
    const abort = new AbortController();
    const pending = run("setInterval(() => {}, 10000)", abort.signal);
    const timer = setTimeout(() => abort.abort(), 500);
    t.after(() => clearTimeout(timer));
    await assert.rejects(pending, { name: "AbortError" });
  },
);
