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
