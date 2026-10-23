import { expect, test } from "bun:test";
import { createRequire } from "node:module";
const { patchContents } = require("../patch-claude-display.ts");

function fixture(names: string[]) {
  const [version, download, verify, update, platform, install, policy, minimum] = names;
  return `var base="https://downloads.claude.ai/claude-code-releases";
function ${platform}(){return "darwin-arm64"}
async function ${install}(v,opts){return {}}
async function ${policy}(){return {}}
function ${minimum}(v){return false}
async function ${version}(e){throw new Error("Test-fixture version rejected outside test builds")}
async function ${download}(e,n,{explicitVersionRequested:r,requireEnforcingRelease:s}){return{downloadType:"binary",signatureVerified:true}}
async function ${verify}(e,n,r){let s=${platform}(),{manifest:m}=await fetchManifest(base,e,{purpose:"reverify"});return{binaryMatches:true}}
async function ${update}(e,n=!1){let{maxVersion:w,forceDowngradeEnabled:b}=await ${policy}(),S=e;const build={VERSION:"2.1.309"};log(\`Checking for native installer update to version \${S}\`);if(!n&&${minimum}(S))return log("tengu_native_update_skipped_minimum_version");return await ${install}(S,{forceReinstall:n})}
return {version:${version},download:${download},verify:${verify},update:${update}};`;
}

test("redirects all native update entry points independently of minified identifiers", async () => {
  for (const names of [
    ["resolve", "getBinary", "reverify", "installLatest", "getPlatform", "installVersion", "getPolicy", "belowMinimum"],
    ["$a", "Z1", "_q", "xY", "Q_", "s4", "$P", "wN"],
  ]) {
    const original = fixture(names);
    const { contents: [patched], patchResults } = patchContents([original]);
    expect(patchResults.get("patched-release-updater")).toMatchObject({ candidates: 1, patched: 1 });
    expect(patchContents([patched]).contents[0]).toBe(patched);
    const requests: string[] = [];
    const updater = {
      version: async (v: string) => { requests.push(`version:${v}`); return "2.1.310"; },
      download: async (v: string, dir: string) => requests.push(`download:${v}:${dir}`),
      verify: async (v: string, file: string) => requests.push(`verify:${v}:${file}`),
      update: async (channel: string, force: boolean) => requests.push(`update:${channel}:${force}`),
    };
    const functions = new Function("require", patched.replace("return {version:", "__patchedClaudeUpdater=arguments[1];return {version:"))(
      createRequire(import.meta.url), updater
    );
    expect(await functions.version("latest")).toBe("2.1.310");
    await functions.download("2.1.310", "staging", {});
    await functions.verify("2.1.310", "retained");
    await functions.update("stable", true);
    expect(requests).toEqual(["version:latest", "download:2.1.310:staging", "verify:2.1.310:retained", "update:stable:true"]);
  }
});

test("leaves unknown updater shapes unchanged so required native coverage can reject them", () => {
  const source = fixture(["a", "b", "c", "d", "e", "f", "g", "h"]).replace("purpose:\"reverify\"", "purpose:\"unknown\"");
  const result = patchContents([source]);
  expect(result.contents[0]).toBe(source);
  expect(result.patchResults.get("patched-release-updater").patched).toBe(0);
});

test("manual updates report a successful patch revision even when the Claude version is unchanged", () => {
  const source = `function report(result){const error="Failed to install native update";if(result.wasUpdated&&result.latestVersion!=={VERSION:"2.1.309"}.VERSION)return "installed";return "current"}return report;`;
  const { contents: [patched] } = patchContents([source]);
  const report = new Function(patched)();
  expect(report({ wasUpdated: true, latestVersion: "2.1.309" })).toBe("installed");
  expect(report({ wasUpdated: true, latestVersion: "2.1.310" })).toBe("installed");
  expect(report({ wasUpdated: false, latestVersion: "2.1.309" })).toBe("current");
});
