import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createPatchedReleaseUpdater } = require("../scripts/patched-release-updater.js");
const { createFeed, compareFeeds } = require("../scripts/publish-update-feed.js");
const releaseBase = "https://github.com/test/patches/releases/download";
const payload = Buffer.from('#!/bin/sh\nprintf "2.1.310 (Claude Code)\\n(patched)\\n"\n');

function feed(platform = "macos-arm64", version = "2.1.310", revision = 1, binary = payload) {
  const assetName = platform === "macos-arm64" ? "claude.native.macos.patched"
    : platform.startsWith("win32-") ? "claude.native.windows.patched.exe" : "claude.native.patched";
  const tag = `v${version}-${platform}${revision > 1 ? `-${revision}` : ""}`;
  return {
    version, tag, platform, assetName, url: `${releaseBase}/${tag}/${assetName}`,
    sha256: createHash("sha256").update(binary).digest("hex"), size: binary.length,
  };
}

function updater(release: any = feed(), overrides: any = {}) {
  const requests: string[] = [];
  const installs: any[] = [];
  const instance = createPatchedReleaseUpdater({
    currentVersion: "2.1.309", repo: "test/patches", releaseBase,
    platform: () => "darwin-arm64", policy: async () => ({}), belowMinimum: () => false,
    install: async (...args: any[]) => { installs.push(args); return {}; },
    fetch: async (url: string) => {
      requests.push(url);
      if (url.endsWith(".json")) return release ? Response.json(release) : new Response(null, { status: 404 });
      if (url === release?.url) return new Response(payload);
      throw new Error(`Unexpected request: ${url}`);
    },
    ...overrides,
  });
  return { instance, requests, installs };
}

for (const platform of ["macos-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]) {
  test(`selects the ${platform} feed for automatic and manual updates`, async () => {
    const release = feed(platform);
    const { instance, requests, installs } = updater(release, { platform: () => platform });
    expect(await instance.version("stable")).toBe("2.1.310");
    expect(await instance.update("latest")).toEqual({ success: true, latestVersion: "2.1.310" });
    expect(requests).toEqual([`${releaseBase}/patched-updates/${platform}.json`]);
    expect(installs).toEqual([["2.1.310", {
      forceReinstall: false, explicitVersionRequested: true, requireEnforcingRelease: false,
    }]]);
  });
}

test("keeps the current version when the feed is absent, older, or already installed", async () => {
  for (const release of [null, feed("macos-arm64", "2.1.308"), feed("macos-arm64", "2.1.309")]) {
    const { instance, requests, installs } = updater(release);
    expect(await instance.update()).toEqual({ success: true, wasSkipped: true, latestVersion: "2.1.309" });
    expect(installs).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain("claude.ai");
  }
});

test("installs newer patch revisions without reinstalling the same or an older revision", async () => {
  const release = feed("macos-arm64", "2.1.309", 3);
  for (const revision of [1, 2, 3, 4]) {
    const { instance, installs } = updater(release, { releaseTag: `v2.1.309-macos-arm64${revision > 1 ? `-${revision}` : ""}` });
    await instance.update();
    expect(installs).toHaveLength(revision < 3 ? 1 : 0);
    if (revision < 3) expect(installs[0][1].forceReinstall).toBe(true);
  }
});

test("honors version policies and rejects failed activation", async () => {
  for (const overrides of [
    { policy: async () => ({ maxVersion: "2.1.309" }) },
    { belowMinimum: () => true },
  ]) {
    const { instance, installs } = updater(feed(), overrides);
    expect((await instance.update()).wasSkipped).toBe(true);
    expect(installs).toHaveLength(0);
  }
  for (const result of [{ activationFailed: true }, { activationRefused: true }, { skippedUnverifiedRelease: true }]) {
    const { instance } = updater(feed(), { install: async () => result });
    await expect(instance.update()).rejects.toThrow("Could not activate");
  }
});

test("rejects incomplete metadata, other platforms, unsafe URLs, and invalid revision tags", async () => {
  for (const changes of [
    { sha256: undefined }, { size: 0 }, { size: "20" }, { version: "../../bad" },
    { platform: "win32-x64" }, { assetName: "claude" }, { tag: "v2.1.310-macos-arm64-01" },
    { url: "https://downloads.claude.ai/claude" },
  ]) {
    const { instance, installs } = updater({ ...feed(), ...changes });
    await expect(instance.update()).rejects.toThrow("Invalid patched release");
    expect(installs).toHaveLength(0);
  }
  await expect(updater(null, { platform: () => "linux-x64-musl" }).instance.update()).rejects.toThrow("not available");
});

test("network errors retain the current installation and allow a later retry", async () => {
  let failed = true;
  const { instance, installs } = updater(feed(), {
    fetch: async () => failed ? new Response(null, { status: 503 }) : Response.json(feed()),
  });
  await expect(instance.update()).rejects.toThrow("HTTP 503");
  expect(installs).toHaveLength(0);
  failed = false;
  expect((await instance.update()).success).toBe(true);
});

test("verifies downloaded and retained binaries against the published checksum", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patched-updater-"));
  try {
    const { instance } = updater();
    await instance.resolve();
    expect(await instance.download("2.1.310", directory)).toMatchObject({ downloadType: "binary", expectedChecksum: feed().sha256 });
    const filename = join(directory, "claude");
    expect((await instance.verify("2.1.310", filename)).binaryMatches).toBe(true);
    await writeFile(filename, "corrupt");
    expect((await instance.verify("2.1.310", filename)).binaryMatches).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("removes failed downloads and never replaces a current binary", async () => {
  for (const binary of [Buffer.from("truncated"), Buffer.alloc(payload.length, 65), Buffer.alloc(payload.length + 1)]) {
    const directory = await mkdtemp(join(tmpdir(), "patched-updater-failure-"));
    const current = join(directory, "current");
    await writeFile(current, "current patched binary");
    try {
      const { instance } = updater(feed(), {
        fetch: async (url: string) => url.endsWith(".json") ? Response.json(feed()) : new Response(binary),
      });
      await instance.resolve();
      await expect(instance.download("2.1.310", directory)).rejects.toThrow();
      expect(await Bun.file(join(directory, "claude")).exists()).toBe(false);
      expect(await readFile(current, "utf8")).toBe("current patched binary");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("rejects a checksum-valid binary that lacks the patched marker", async () => {
  const binary = Buffer.from('#!/bin/sh\necho "2.1.310 (Claude Code)"\n');
  const release = feed("macos-arm64", "2.1.310", 1, binary);
  const directory = await mkdtemp(join(tmpdir(), "patched-updater-marker-"));
  try {
    const { instance } = updater(release, {
      fetch: async (url: string) => url.endsWith(".json") ? Response.json(release) : new Response(binary),
    });
    await instance.resolve();
    await expect(instance.download("2.1.310", directory)).rejects.toThrow("expected patched Claude");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("explicit version installation also requires a patched GitHub asset", async () => {
  const release = feed();
  const { instance, requests } = updater(null, {
    fetch: async (url: string) => {
      requests.push(url);
      return Response.json({ tag_name: release.tag, assets: [{
        name: release.assetName, browser_download_url: release.url,
        digest: `sha256:${release.sha256}`, size: release.size,
      }] });
    },
  });
  expect((await instance.resolve("2.1.310")).tag).toBe(release.tag);
  expect(requests).toEqual(["https://api.github.com/repos/test/patches/releases/tags/v2.1.310-macos-arm64"]);
  await expect(instance.resolve("../../bad")).rejects.toThrow("Invalid patched release");
});

test("release feeds require a digest and advance monotonically by version and revision", () => {
  const release = feed();
  const metadata = { tag_name: release.tag, assets: [{
    name: release.assetName, browser_download_url: release.url, digest: `sha256:${release.sha256}`, size: release.size,
  }] };
  expect(createFeed(metadata, release.platform)).toEqual(release);
  expect(() => createFeed({ ...metadata, assets: [{ ...metadata.assets[0], digest: null }] }, release.platform)).toThrow();
  expect(compareFeeds(feed("macos-arm64", "2.1.310"), feed("macos-arm64", "2.1.309", 20))).toBe(1);
  expect(compareFeeds(feed("macos-arm64", "2.1.310", 10), feed("macos-arm64", "2.1.310", 2))).toBe(1);
  expect(compareFeeds(release, release)).toBe(0);
});
