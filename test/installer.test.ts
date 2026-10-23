import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("installer selects the patched feed independently of the installed version and verifies before replacement", async () => {
  for (const mode of ["valid", "corrupt", "unpatched", "missing"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "patched-installer-test-"));
    try {
      const bin = join(directory, "bin");
      await mkdir(bin);
      const current = join(directory, "current");
      const oldBinary = '#!/bin/sh\necho "99.99.99 (Claude Code)"\n';
      await writeFile(current, oldBinary, { mode: 0o755 });
      await symlink(current, join(bin, "claude"));
      const binary = Buffer.from(`#!/bin/sh\nprintf "2.1.310 (Claude Code)${mode === "unpatched" ? "" : "\\n(patched)"}\\n"\n`);
      const payloadPath = join(directory, "payload");
      const feedPath = join(directory, "feed.json");
      await writeFile(payloadPath, mode === "corrupt" ? "corrupt" : binary);
      await writeFile(feedPath, JSON.stringify({
        version: "2.1.310", tag: "v2.1.310-linux-x64", platform: "linux-x64", assetName: "claude.native.patched",
        url: "https://github.com/a-connoisseur/patch-claude-code/releases/download/v2.1.310-linux-x64/claude.native.patched",
        sha256: createHash("sha256").update(binary).digest("hex"), size: binary.length,
      }));
      await writeFile(join(bin, "uname"), '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n');
      await writeFile(join(bin, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) url="$1" ;;
    -o) shift; output="$1" ;;
  esac
  shift
done
case "$url" in
  */patched-updates/linux-x64.json)
    [ "$PATCH_TEST_MODE" != missing ] || exit 22
    cp "$PATCH_TEST_FEED" "$output" ;;
  */v2.1.310-linux-x64/claude.native.patched) cp "$PATCH_TEST_PAYLOAD" "$output" ;;
  *) exit 99 ;;
esac
`);
      await chmod(join(bin, "uname"), 0o755);
      await chmod(join(bin, "curl"), 0o755);
      const child = Bun.spawn(["bash", resolve("install-patched-claude.sh")], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PATCH_CLAUDE_REPO: "a-connoisseur/patch-claude-code",
          PATCH_TEST_MODE: mode, PATCH_TEST_FEED: feedPath, PATCH_TEST_PAYLOAD: payloadPath },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exitCode, stdout + stderr).toBe(mode === "valid" ? 0 : 1);
      expect(await readFile(current, "utf8")).toBe(mode === "valid" ? binary.toString() : oldBinary);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
