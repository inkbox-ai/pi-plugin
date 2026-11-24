import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../gateway/project-tools.js";

test("project grants edit one named file but not neighbors, hidden paths, or links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-grants-"));
  const original = process.cwd(),
    granted = process.env.INKBOX_PI_GRANTED_FILES;
  try {
    process.chdir(dir);
    process.env.INKBOX_PI_GRANTED_FILES = JSON.stringify([
      "source.js",
      "link.js",
      ".hidden",
      "../outside",
    ]);
    await writeFile("source.js", "export const n = 1;\n");
    await writeFile("another.js", "secret");
    await symlink("another.js", "link.js");
    const tools = new Map();
    register({
      registerTool(tool) {
        tools.set(tool.name, tool.execute);
      },
    });
    const read = tools.get("inkbox_project_read"),
      edit = tools.get("inkbox_project_replace");
    assert.match(
      (await read("", { file: "source.js" })).content[0].text,
      /n = 1/,
    );
    await edit("", { file: "source.js", oldText: "n = 1", newText: "n = 2" });
    assert.match(await readFile("source.js", "utf8"), /n = 2/);
    for (const file of ["another.js", "link.js", ".hidden", "../outside"])
      await assert.rejects(read("", { file }));
    await assert.rejects(
      edit("", { file: "source.js", oldText: "absent", newText: "x" }),
    );
    assert.equal(await readFile("another.js", "utf8"), "secret");
  } finally {
    if (granted === undefined) delete process.env.INKBOX_PI_GRANTED_FILES;
    else process.env.INKBOX_PI_GRANTED_FILES = granted;
    process.chdir(original);
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct edit requires the exact approved proposal and rejects a file changed during review", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-edit-review-"));
  const cwd = process.cwd();
  const restore = (name, old) => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  };
  const granted = process.env.INKBOX_PI_GRANTED_FILES;
  const confirm = process.env.INKBOX_PI_CONFIRM_EDITS;
  t.after(async () => {
    restore("INKBOX_PI_GRANTED_FILES", granted);
    restore("INKBOX_PI_CONFIRM_EDITS", confirm);
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  process.env.INKBOX_PI_GRANTED_FILES = '["note.md"]';
  process.env.INKBOX_PI_CONFIRM_EDITS = "1";
  const before = "\uFEFFfirst\nsecond\n";
  await writeFile("note.md", before);
  const tools = {};
  register({
    registerTool(tool) {
      tools[tool.name] = tool.execute;
    },
  });
  const proposal = {
    file: "note.md",
    oldText: "first",
    newText: "hello\nworld",
  };
  const edit = (
    review,
    args = proposal,
    signal = new AbortController().signal,
  ) =>
    tools.inkbox_project_replace("", args, signal, undefined, {
      mode: "rpc",
      ui: { confirm: review },
    });
  await assert.rejects(
    edit(async (_title, encoded) => {
      assert.deepEqual(JSON.parse(encoded), proposal);
      return false;
    }),
    /not approved/,
  );
  assert.equal(await readFile("note.md", "utf8"), before);
  await assert.rejects(
    edit(() => assert.fail("oversize proposal reached the owner"), {
      ...proposal,
      newText: "a".repeat(1201),
    }),
    /too long/,
  );
  await assert.rejects(
    edit(async () => {
      await writeFile("note.md", "independent edit\n");
      return true;
    }),
    /File changed/,
  );
  assert.equal(await readFile("note.md", "utf8"), "independent edit\n");

  await writeFile("note.md", before);
  const abort = new AbortController();
  await assert.rejects(
    edit(
      () => {
        abort.abort();
        return true;
      },
      proposal,
      abort.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(await readFile("note.md", "utf8"), before);
  await edit(() => true);
  assert.equal(
    await readFile("note.md", "utf8"),
    "\uFEFFhello\nworld\nsecond\n",
  );
});
