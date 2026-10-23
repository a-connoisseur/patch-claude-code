import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const originalInput = process.env.CLAUDE_UPDATER_TEST_ORIGINAL;
const nativeTest = originalInput && process.platform === "darwin" && process.arch === "arm64" ? test : test.skip;

nativeTest("native claude update installs only verified patched assets in an isolated installation", async () => {
  const { readNativeBunModules, writeNativeBunModules } = require("../scripts/native-bun.ts");
  const { patchContents } = require("../patch-claude-display.ts");
  const original = resolve(originalInput!);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "claude-patched-update-native-")));
  const home = join(directory, "home");
  const versions = join(home, ".local", "share", "claude", "versions");
  const launcher = join(home, ".local", "bin", "claude");
  await mkdir(versions, { recursive: true });
  await mkdir(dirname(launcher), { recursive: true });
  await mkdir(join(home, "config"), { recursive: true });
  const modules = readNativeBunModules(original).filter((entry: any) => entry.name.endsWith(".js") || entry.name.endsWith("/root/cli") || entry.name.endsWith("/claude"));
  const version = modules.map((entry: any) => entry.content.match(/VERSION:"(\d+\.\d+\.\d+)"/)?.[1]).find(Boolean);
  expect(version).toBeTruthy();
  const parts = version.split(".").map(Number);
  const previous = `${parts[0]}.${parts[1]}.${parts[2] - 1}`;
  const source = join(versions, previous);
  const target = join(directory, "target");
  let mode = "valid";
  let payload: Buffer;
  let manifest: any;
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      requests.push(pathname);
      if (pathname === "/patched-updates/macos-arm64.json") {
        return mode === "missing" ? new Response(null, { status: 404 }) : Response.json(manifest);
      }
      if (pathname === `/${manifest?.tag}/${manifest?.assetName}`) {
        return new Response(mode === "corrupt" ? Buffer.from("corrupt") : payload);
      }
      return new Response(null, { status: 404 });
    },
  });
  const releaseBase = `http://127.0.0.1:${server.port}`;
  const saved = { releaseBase: process.env.PATCH_CLAUDE_RELEASE_BASE, tag: process.env.PATCH_CLAUDE_RELEASE_TAG };
  async function build(filename: string, buildVersion: string) {
    process.env.PATCH_CLAUDE_RELEASE_BASE = releaseBase;
    process.env.PATCH_CLAUDE_RELEASE_TAG = `v${buildVersion}-macos-arm64`;
    const contents = modules.map((entry: any) => entry.content.replaceAll(`VERSION:"${version}"`, `VERSION:"${buildVersion}"`));
    const result = patchContents(contents);
    expect(result.patchResults.get("patched-release-updater").patched).toBe(1);
    await copyFile(original, filename);
    const replacements = new Map();
    modules.forEach((entry: any, index: number) => {
      if (entry.content !== result.contents[index]) replacements.set(entry.name, result.contents[index]);
    });
    writeNativeBunModules(filename, replacements);
    execFileSync("chmod", ["+x", filename]);
    execFileSync("codesign", ["-f", "-s", "-", filename], { stdio: "pipe" });
  }
  try {
    await build(source, previous);
    await build(target, version);
    payload = await readFile(target);
    manifest = {
      version, tag: `v${version}-macos-arm64`, platform: "macos-arm64", assetName: "claude.native.macos.patched",
      url: `${releaseBase}/v${version}-macos-arm64/claude.native.macos.patched`,
      sha256: createHash("sha256").update(payload).digest("hex"), size: payload.length,
    };
    await symlink(source, launcher);
    const env = {
      ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, "config"),
      XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      PATH: `${dirname(launcher)}:${process.env.PATH}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_PROXY: "127.0.0.1,localhost",
    };
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "DISABLE_AUTOUPDATER", "DISABLE_UPDATES", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) delete env[key];
    await writeFile(join(home, "config", ".claude.json"), JSON.stringify({ installMethod: "native" }));
    async function runUpdate() {
      const child = Bun.spawn([launcher, "update"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      console.log(stdout + stderr);
      return { exitCode, output: stdout + stderr };
    }
    expect((await runUpdate()).exitCode).toBe(0);
    const installed = await realpath(launcher);
    expect(installed).toBe(join(versions, version));
    expect(createHash("sha256").update(await readFile(installed)).digest("hex")).toBe(manifest.sha256);
    expect(execFileSync(launcher, ["--version"], { env, encoding: "utf8" })).toContain("(patched)");
    expect(requests).toEqual(["/patched-updates/macos-arm64.json", `/${manifest.tag}/${manifest.assetName}`]);

    await unlink(launcher);
    await symlink(source, launcher);
    await rm(installed);
    mode = "corrupt";
    const failed = await runUpdate();
    expect(failed.exitCode).toBe(1);
    expect(failed.output).toContain("checksum mismatch");
    expect(await realpath(launcher)).toBe(source);

    mode = "missing";
    expect((await runUpdate()).exitCode).toBe(0);
    expect(await realpath(launcher)).toBe(source);
  } finally {
    if (saved.releaseBase === undefined) delete process.env.PATCH_CLAUDE_RELEASE_BASE;
    else process.env.PATCH_CLAUDE_RELEASE_BASE = saved.releaseBase;
    if (saved.tag === undefined) delete process.env.PATCH_CLAUDE_RELEASE_TAG;
    else process.env.PATCH_CLAUDE_RELEASE_TAG = saved.tag;
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
