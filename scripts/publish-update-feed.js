const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function createFeed(release, platform) {
  const assetName = platform === "macos-arm64" ? "claude.native.macos.patched"
    : platform.startsWith("win32-") ? "claude.native.windows.patched.exe" : "claude.native.patched";
  const match = release.tag_name.match(new RegExp(`^v(\\d+\\.\\d+\\.\\d+)-${platform}(?:-([2-9]|[1-9]\\d+))?$`));
  const asset = release.assets.find((entry) => entry.name === assetName);
  if (!match || release.draft || release.prerelease || !asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error(`Release ${release.tag_name} is not a verified patched release for ${platform}`);
  }
  return {
    version: match[1], tag: release.tag_name, platform, assetName,
    url: asset.browser_download_url, sha256: asset.digest.slice(7), size: asset.size,
  };
}

function compareFeeds(left, right) {
  const parts = (feed) => [...feed.version.split(".").map(Number), Number(feed.tag.match(/-(\d+)$/)?.[1] || 1)];
  const a = parts(left), b = parts(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function publish(repo, tag, platform) {
  function gh(args) {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }
  function metadata(releaseTag, allowMissing = false) {
    try { return JSON.parse(gh(["api", `repos/${repo}/releases/tags/${releaseTag}`])); } catch (error) {
      if (allowMissing && String(error.stderr).includes("HTTP 404")) return null;
      throw error;
    }
  }
  const release = metadata(tag);
  if (!new RegExp(`^v\\d+\\.\\d+\\.\\d+-${platform}(?:-([2-9]|[1-9]\\d+))?$`).test(tag)) {
    console.log(`Custom release ${tag} does not advance the update feed`);
    return;
  }
  const buildMetadata = gh(["release", "download", tag, "--repo", repo, "--pattern", "metadata.txt", "--output", "-"]);
  if (!/^patched_updater=1\r?$/m.test(buildMetadata)) {
    console.log(`Release ${tag} does not include the patched updater`);
    return;
  }
  const feed = createFeed(release, platform);
  let channel = metadata("patched-updates", true);
  if (!channel) {
    try {
      gh(["release", "create", "patched-updates", "--repo", repo, "--prerelease", "--title", "Patched update feeds", "--notes", "Per-platform metadata for verified patched Claude updates."]);
    } catch (error) {
      // Platform jobs can race to create the shared feed release.
      if (!metadata("patched-updates", true)) throw error;
    }
    channel = metadata("patched-updates");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "patched-update-feed-"));
  const filename = path.join(directory, `${platform}.json`);
  try {
    if (channel.assets.some((asset) => asset.name === `${platform}.json`)) {
      gh(["release", "download", "patched-updates", "--repo", repo, "--pattern", `${platform}.json`, "--output", filename]);
      const existing = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (compareFeeds(feed, existing) <= 0) {
        console.log(`Keeping update feed at ${existing.tag}`);
        return;
      }
    }
    fs.writeFileSync(filename, `${JSON.stringify(feed, null, 2)}\n`);
    gh(["release", "upload", "patched-updates", "--repo", repo, "--clobber", filename]);
    console.log(`Published ${platform} update feed for ${tag}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { createFeed, compareFeeds };
if (require.main === module) {
  const [repo, tag, platform] = process.argv.slice(2);
  if (!repo || !tag || !platform) throw new Error("Usage: node scripts/publish-update-feed.js <repo> <tag> <platform>");
  publish(repo, tag, platform);
}
