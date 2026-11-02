import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const installerRequire = createRequire(require.resolve("electron-winstaller"));
const temp = installerRequire("temp");

test("packaging cleanup removes tracked temporary trees with both legacy APIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "mindweaver-packaging-"));
  temp.track();

  try {
    for (const synchronous of [false, true]) {
      const options = { dir: root, prefix: "literal[one]-" };
      const directory = synchronous ? temp.mkdirSync(options) : await promisify(temp.mkdir)(options);
      assert.equal(resolve(dirname(directory)), resolve(root));
      await mkdir(join(directory, "nested"));
      await writeFile(join(directory, "nested", "fixture.txt"), "packaging fixture");
      const result = synchronous ? temp.cleanupSync() : await promisify(temp.cleanup)();
      assert.equal(result.dirs, 1);
      await assert.rejects(access(directory), { code: "ENOENT" });
      const empty = synchronous ? temp.cleanupSync() : await promisify(temp.cleanup)();
      assert.equal(empty.dirs, 0);

      const missing = synchronous ? temp.mkdirSync(options) : await promisify(temp.mkdir)(options);
      assert.equal(resolve(dirname(missing)), resolve(root));
      await rm(missing, { recursive: true, force: true });
      const sibling = join(root, basename(missing).replace("[one]", "o"));
      await mkdir(sibling);
      await writeFile(join(sibling, "keep.txt"), "untracked sibling");
      const missingResult = synchronous ? temp.cleanupSync() : await promisify(temp.cleanup)();
      assert.equal(missingResult.dirs, 1);
      assert.equal(await readFile(join(sibling, "keep.txt"), "utf8"), "untracked sibling");
    }
  } finally {
    const resolvedRoot = resolve(root);
    assert.equal(resolve(dirname(resolvedRoot)), resolve(tmpdir()));
    await rm(resolvedRoot, { recursive: true, force: true });
    temp.track(false);
  }
});
