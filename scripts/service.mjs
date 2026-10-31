#!/usr/bin/env node
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const serviceLabel = "com.figma-local-bridge.owner";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const xml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));

function stableNodePath(path) {
  const match = path.match(/^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/);
  const stable = match && `${match[1]}/opt/${match[2]}/bin/node`;
  return stable && existsSync(stable) ? stable : path;
}

export function serviceConfiguration(options = {}) {
  const home = options.home ?? homedir();
  const repo = options.repository ?? repository;
  const node = options.node ?? stableNodePath(process.execPath);
  const preferences = options.preferences ?? process.env.FIGMA_PREFERENCES_DIR ?? join(home, ".figma-local-bridge");
  for (const path of [home, repo, node, preferences]) if (!isAbsolute(path)) throw new Error("Service paths must be absolute.");
  return {
    label: serviceLabel,
    plist: join(home, "Library", "LaunchAgents", `${serviceLabel}.plist`),
    logs: join(home, "Library", "Logs", "FigmaLocalBridge"),
    command: [node, join(repo, "dist", "server.mjs"), "--http-owner"],
    preferences,
    environment: {
      FIGMA_BRIDGE_HOST: "127.0.0.1",
      FIGMA_BRIDGE_PORT: "3846",
      FIGMA_BRIDGE_API_DISABLED: "1",
      FIGMA_PREFERENCES_DIR: preferences,
      FIGMA_API_BASE_URL: "http://127.0.0.1:9",
      FIGMA_ACCESS_TOKEN: "",
      FIGMA_FILE_KEY: "",
      FIGMA_CREDENTIAL_BACKEND: "memory",
    },
  };
}

export function renderServicePlist(config) {
  const environment = Object.entries(config.environment).map(([key, value]) => `      <key>${xml(key)}</key><string>${xml(value)}</string>`).join("\n");
  const args = config.command.map((value) => `      <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${xml(config.label)}</string>
    <key>ProgramArguments</key><array>
${args}
    </array>
    <key>WorkingDirectory</key><string>${xml(dirname(dirname(config.command[1])))}</string>
    <key>EnvironmentVariables</key><dict>
${environment}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>ProcessType</key><string>Background</string>
    <key>Umask</key><integer>63</integer>
    <key>StandardOutPath</key><string>${xml(join(config.logs, "owner.stdout.log"))}</string>
    <key>StandardErrorPath</key><string>${xml(join(config.logs, "owner.stderr.log"))}</string>
  </dict>
</plist>
`;
}

function launchctl(...args) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

async function main() {
  const [action = "status", ...flags] = process.argv.slice(2);
  let preferences;
  let node;
  let dryRun = false;
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === "--dry-run") dryRun = true;
    else if (flags[index] === "--preferences-dir" && flags[index + 1]) preferences = resolve(flags[++index]);
    else if (flags[index] === "--node" && flags[index + 1]) node = resolve(flags[++index]);
    else throw new Error(`Unknown option: ${flags[index]}`);
  }
  if (!["install", "start", "restart", "stop", "status", "uninstall"].includes(action)) throw new Error("Use install, start, restart, stop, status, or uninstall.");
  const config = serviceConfiguration({ preferences, node });
  if (dryRun) {
    console.log(JSON.stringify({ action, plist: config.plist, command: config.command, preferences: config.preferences, environment: config.environment }, null, 2));
    return;
  }
  if (process.platform !== "darwin") throw new Error("The background service uses macOS launchd.");
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${serviceLabel}`;
  if (action === "install") {
    await readFile(config.command[1]);
    await mkdir(dirname(config.plist), { recursive: true });
    await mkdir(config.logs, { recursive: true, mode: 0o700 });
    await mkdir(config.preferences, { recursive: true, mode: 0o700 });
    for (const file of ["owner.stdout.log", "owner.stderr.log"]) await writeFile(join(config.logs, file), "", { flag: "a", mode: 0o600 });
    const temporary = `${config.plist}.tmp-${process.pid}`;
    await writeFile(temporary, renderServicePlist(config), { mode: 0o600, flag: "wx" });
    try {
      const lint = spawnSync("/usr/bin/plutil", ["-lint", temporary], { encoding: "utf8" });
      if (lint.status !== 0) throw new Error(`Invalid launch agent: ${lint.stderr || lint.stdout}`);
      await rename(temporary, config.plist);
    } finally { await unlink(temporary).catch(() => {}); }
    console.log(`Installed ${config.plist}. Run service.mjs start when the previous bridge owner is stopped.`);
    return;
  }
  if (action === "status") {
    const result = launchctl("print", target);
    if (result.status !== 0) { console.log("Background bridge service is not loaded."); process.exitCode = 1; return; }
    const lines = result.stdout.split("\n").filter((line) => /^\s*(state|pid|runs|last exit code)\s*=/.test(line));
    console.log(`${serviceLabel}\n${lines.map((line) => line.trim()).join("\n")}`);
    return;
  }
  if (action === "stop" || action === "uninstall") {
    const result = launchctl("bootout", target);
    if (result.status !== 0 && !/could not find service|no such process/i.test(result.stderr)) throw new Error(result.stderr.trim() || "Could not stop the service.");
    if (action === "uninstall") await unlink(config.plist).catch((error) => { if (error.code !== "ENOENT") throw error; });
    console.log(action === "uninstall" ? "Background bridge service removed." : "Background bridge service stopped.");
    return;
  }
  if (action === "restart") {
    const result = launchctl("kickstart", "-k", target);
    if (result.status !== 0) throw new Error(result.stderr.trim() || "Could not restart the service.");
    console.log("Background bridge service restarted.");
    return;
  }
  const loaded = launchctl("print", target);
  if (loaded.status === 0) { console.log("Background bridge service is already loaded."); return; }
  const result = launchctl("bootstrap", domain, config.plist);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Could not start the service.");
  console.log("Background bridge service started.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
