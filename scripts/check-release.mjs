import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function assertMatchingVersions(versions, tag) {
  const version = versions.package;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Package version must be a release version.");
  for (const [source, value] of Object.entries(versions)) {
    if (value !== version) throw new Error(`${source} version ${value ?? "missing"} does not match package version ${version}. Update both halves of the release together.`);
  }
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Release tag must be v${version}; received ${tag}.`);
  return version;
}

export async function checkRelease(root = repository, tag) {
  const json = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));
  const info = await json("package.json");
  const lock = await json("package-lock.json");
  const runtimeVersion = async (path, constant) => {
    const source = await readFile(join(root, path), "utf8");
    return source.match(new RegExp(`const ${constant} = ["']([^"']+)["']`))?.[1];
  };
  return assertMatchingVersions({
    package: info.version,
    lock: lock.version,
    "lock root": lock.packages?.[""]?.version,
    "Claude Desktop manifest": (await json("desktop-extension/manifest.json")).version,
    "Claude Code manifest": (await json(".claude-plugin/plugin.json")).version,
    "Codex manifest": (await json(".codex-plugin/plugin.json")).version,
    "bridge runtime": await runtimeVersion("server.mjs", "bridgeVersion"),
    "Figma plugin runtime": await runtimeVersion("plugin/code.js", "pluginVersion"),
  }, tag);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error("Usage: node scripts/check-release.mjs [vVERSION]");
  console.log(`Release versions match: ${await checkRelease(repository, process.argv[2])}`);
}
