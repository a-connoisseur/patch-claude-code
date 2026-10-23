function createPatchedReleaseUpdater(options, loadBuiltin = require) {
  const fs = loadBuiltin("node:fs");
  const fsp = loadBuiltin("node:fs/promises");
  const path = loadBuiltin("node:path");
  const { createHash } = loadBuiltin("node:crypto");
  const { Readable, Transform } = loadBuiltin("node:stream");
  const { pipeline } = loadBuiltin("node:stream/promises");
  const { execFileSync } = loadBuiltin("node:child_process");
  const repo = options.repo || "a-connoisseur/patch-claude-code";
  const releaseBase = options.releaseBase || `https://github.com/${repo}/releases/download`;
  const apiBase = options.apiBase || `https://api.github.com/repos/${repo}`;
  const fetchRelease = options.fetch || globalThis.fetch;
  const platform = options.platform().replace(/^darwin-/, "macos-");
  const assetNames = {
    "macos-arm64": "claude.native.macos.patched",
    "linux-x64": "claude.native.patched",
    "linux-arm64": "claude.native.patched",
    "win32-x64": "claude.native.windows.patched.exe",
    "win32-arm64": "claude.native.windows.patched.exe",
  };
  const assetName = assetNames[platform];
  const releases = new Map();
  let latestRequest;
  let latestAt = 0;

  function compareVersions(left, right) {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  }

  function validate(release) {
    if (!assetName) throw new Error(`Patched updates are not available for ${platform}`);
    if (!release || !/^\d+\.\d+\.\d+$/.test(release.version)) {
      throw new Error("Invalid patched release version");
    }
    const baseTag = `v${release.version}-${platform}`;
    const suffix = release.tag?.slice(baseTag.length);
    if (
      !release.tag?.startsWith(baseTag) ||
      (suffix !== "" && !/^-(?:[2-9]|[1-9]\d+)$/.test(suffix)) ||
      release.platform !== platform ||
      release.assetName !== assetName ||
      release.url !== `${releaseBase}/${release.tag}/${assetName}` ||
      !/^[a-f0-9]{64}$/.test(release.sha256) ||
      !Number.isSafeInteger(release.size) || release.size <= 0
    ) {
      throw new Error(`Invalid patched release metadata for ${platform}`);
    }
    return { ...release, revision: suffix ? Number(suffix.slice(1)) : 1 };
  }

  async function json(url, allowMissing = false) {
    const response = await fetchRelease(url, {
      headers: { Accept: "application/json", "User-Agent": "patch-claude-code-updater" },
      signal: AbortSignal.timeout(30000),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Patched update check failed: HTTP ${response.status}`);
    return response.json();
  }

  async function resolve(channel = "latest") {
    if (!assetName) throw new Error(`Patched updates are not available for ${platform}`);
    if (channel === "latest" || channel === "stable") {
      if (!latestRequest || Date.now() - latestAt >= 300000) {
        latestAt = Date.now();
        latestRequest = json(`${releaseBase}/patched-updates/${platform}.json`, true)
          .then((value) => value === null ? null : validate(value))
          .catch((error) => { latestRequest = undefined; throw error; });
      }
      const release = await latestRequest;
      if (release) releases.set(release.version, release);
      return release;
    }
    const version = channel.replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid patched release: ${channel}`);
    if (releases.has(version)) return releases.get(version);
    const tag = `v${version}-${platform}`;
    const metadata = await json(`${apiBase}/releases/tags/${tag}`);
    const asset = metadata.assets?.find((entry) => entry.name === assetName);
    if (metadata.draft || metadata.prerelease || metadata.tag_name !== tag || !asset) {
      throw new Error(`No patched release for ${version} on ${platform}`);
    }
    const release = validate({
      version, tag, platform, assetName,
      url: asset.browser_download_url,
      sha256: asset.digest?.replace(/^sha256:/, ""),
      size: asset.size,
    });
    releases.set(version, release);
    return release;
  }

  async function checksum(filename) {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest("hex");
  }

  async function verify(version, filename) {
    const release = await resolve(version);
    let binaryMatches = false;
    try { binaryMatches = await checksum(filename) === release.sha256; } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { signatureVerified: true, binaryMatches, expectedChecksum: release.sha256 };
  }

  async function download(version, directory) {
    const release = await resolve(version);
    await fsp.mkdir(directory, { recursive: true });
    const filename = path.join(directory, platform.startsWith("win32-") ? "claude.exe" : "claude");
    const response = await fetchRelease(release.url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body) throw new Error(`Patched download failed: HTTP ${response.status}`);
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > release.size) return callback(new Error("Patched download exceeds its published size"));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(filename, { flags: "wx", mode: 0o755 }));
      if (size !== release.size || hash.digest("hex") !== release.sha256) {
        throw new Error("Patched download checksum mismatch; keeping the current installation");
      }
      await fsp.chmod(filename, 0o755);
      const output = execFileSync(filename, ["--version"], { encoding: "utf8", timeout: 30000 });
      if (!output.includes("(patched)") || output.match(/\d+\.\d+\.\d+/)?.[0] !== version) {
        throw new Error("Downloaded binary does not identify as the expected patched Claude version");
      }
      return { downloadType: "binary", signatureVerified: true, expectedChecksum: release.sha256 };
    } catch (error) {
      await fsp.rm(filename, { force: true });
      throw error;
    }
  }

  async function update(channel = "latest", force = false) {
    const release = await resolve(channel);
    const skipped = { success: true, wasSkipped: true, latestVersion: options.currentVersion };
    if (!release) return skipped;
    const explicit = /^v?\d+\.\d+\.\d+$/.test(channel);
    const currentTag = options.releaseTag || `v${options.currentVersion}-${platform}`;
    const currentRevision = Number(currentTag.match(/-(\d+)$/)?.[1] || 1);
    const comparison = compareVersions(release.version, options.currentVersion);
    if (!explicit && (comparison < 0 || (!force && comparison === 0 && release.revision <= currentRevision))) {
      return skipped;
    }
    const policy = await options.policy();
    if ((!force && policy.maxVersion && compareVersions(release.version, policy.maxVersion) > 0) || options.belowMinimum(release.version)) {
      return skipped;
    }
    const result = await options.install(release.version, {
      forceReinstall: force || comparison === 0 && release.revision > currentRevision,
      explicitVersionRequested: true,
      requireEnforcingRelease: false,
    });
    if (result.activationFailed || result.activationRefused || result.skippedUnverifiedRelease) {
      throw new Error("Could not activate the patched update; keeping the current launcher");
    }
    return { success: true, latestVersion: release.version };
  }

  return {
    resolve, download, verify, update,
    async version(channel) { return (await resolve(channel))?.version || options.currentVersion; },
  };
}

module.exports = { createPatchedReleaseUpdater };
