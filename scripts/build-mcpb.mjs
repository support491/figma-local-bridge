import { build } from "esbuild";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRelease } from "./check-release.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

async function dependencyNotices(inputs) {
  const packages = new Map();
  for (const input of Object.keys(inputs).filter((path) => path.includes("node_modules/"))) {
    let directory = dirname(resolve(repository, input));
    while (directory !== repository && directory !== dirname(directory)) {
      try {
        const info = await json(join(directory, "package.json"));
        if (info.name && info.version) {
          packages.set(directory, info);
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = dirname(directory);
    }
  }
  const notices = ["Third party software included in the bundled bridge\n"];
  for (const [directory, info] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const licenses = (await readdir(directory)).filter((name) => /^(licen[cs]e|notice)([.-].*)?$/i.test(name)).sort();
    if (!licenses.length) throw new Error(`Missing license text for bundled dependency ${info.name}.`);
    notices.push(`\n${"=".repeat(72)}\n${info.name} ${info.version}\nLicense: ${info.license ?? "See below"}\n`);
    for (const license of licenses) notices.push(`\n${license}\n${await readFile(join(directory, license), "utf8")}\n`);
  }
  return notices.join("");
}

function archive(files) {
  // Fixed timestamps and sorted entries make repeat builds byte-identical.
  const entries = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [
    name, [bytes, { mtime: new Date(2000, 0, 1), os: 3, attrs: 0o100644 << 16 }],
  ]));
  return zipSync(entries, { level: 9 });
}

function staffInstructions(extensionName) {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install Figma Local Bridge</title>
<style>body{max-width:760px;margin:48px auto;padding:0 24px;font:18px/1.6 system-ui,sans-serif;color:#171717}h1{font-size:32px;line-height:1.2}h2{margin-top:32px;font-size:24px}li{margin-bottom:12px}code{font-size:.9em;overflow-wrap:anywhere}blockquote{margin:18px 0 18px 24px}a{color:#174b83}</style>
<h1>Install Figma Local Bridge</h1>
<p>For Claude Desktop and Figma Desktop on a Mac. Install both parts once. You do not need Terminal, npm, a separate Node.js installation, or an API token.</p>
<h2>1 Install the Claude extension</h2>
<ol><li>Open Claude Desktop and go to <b>Settings → Desktop app → Extensions → Manage</b>. Older versions show <b>Settings → Extensions</b>.</li>
<li>Open <b>Advanced settings</b>, choose <b>Install Extension…</b>, and select <code>${extensionName}</code> from this folder.</li>
<li>Review and approve the installation. This is an unsigned private build; ask your Claude administrator if company policy blocks it.</li>
<li>Start a regular chat. Under <b>+ → Connectors</b>, enable <b>Figma Local Bridge</b> if needed. Completely quit and reopen Claude if prompted.</li></ol>
<h2>2 Install the Figma plugin</h2>
<ol><li>Move the <b>figma-local-bridge</b> folder from this download to a permanent location, such as Documents. Keep it there.</li>
<li>Open a Figma Design file in Figma Desktop. Choose <b>Plugins → Development → Import plugin from manifest…</b>.</li>
<li>Select <b>manifest.json</b> inside the folder you moved. Click <b>Open</b>.</li>
<li>Run <b>Plugins → Development → Local MCP Bridge</b>. Leave its panel open.</li>
<li>Check the file and page shown in the welcome screen. If you see a connection problem, open <b>Check connection</b> and follow the displayed step.</li></ol>
<h2>3 Ask Claude to check the file</h2>
<ol><li>Choose the task to check your file, then click <b>Copy instructions for Claude</b>.</li><li>Paste into a regular Claude Desktop chat. Check that Claude confirms the correct file and page before working.</li><li>For an edit, select the design in Figma and click <b>Work on a copy</b>. This creates a duplicate immediately and selects it.</li><li>Choose a marketing task, add your details, and copy the updated instructions into Claude. Check the result in Figma.</li></ol>
<p>Task templates help you change a headline, create a campaign variation, or export selected graphics. They prepare instructions for Claude; copying a prompt does not run it.</p>
<h2>4 Create a campaign</h2>
<ol><li>Open <b>Campaign Studio</b> in the plugin. Import the brand kit Arsenio provides, or save your approved colours, fonts and writing guidance.</li>
<li>Select a source artboard, enter your audience, offer and call to action, and prepare three concept workspaces.</li>
<li>Copy the campaign brief into Claude. Claude develops the three directions and reviews rendered previews. Preparing workspaces alone does not generate a finished design.</li>
<li>Compare the designs, choose one, and approve it after its checks and visual review are complete.</li>
<li>Create the sizes you need, review and approve each, then ask Claude to export the approved campaign. Save a checkpoint before requesting changes.</li></ol>
<p>Read <b>CAMPAIGN-STUDIO.md</b> for the walkthrough. Optional image generation stays off unless an administrator enables a separately billed provider. No image API key is needed for ordinary Figma campaign work.</p>
<p>To undo an edit, click the Figma canvas and press <b>Command Z</b>. A task may contain several edits, so undo one step at a time and inspect the result.</p>
<h2>Each day</h2><p>Open Claude, open the Figma file, run Local MCP Bridge, and leave the panel open. Check the displayed file and page, then copy fresh instructions for your task. Copy again after changing pages or restarting the plugin.</p>
<p>If Arsenio helped you install an earlier version using Terminal, ask him to update that installation first. Use this plugin in regular Claude Desktop chats.</p>
<p>If tools are missing, quit and reopen Claude. Use <b>Check connection</b> for connection or version problems. You can copy support details for Arsenio; nothing is sent automatically.</p>
<p>The bridge runs locally while Claude is open. API/comment access stays disabled. See <b>INSTALL.md</b> for upgrade details and the local security boundary.</p>
<p>Administrators: use <b>TEAM-DEPLOYMENT.md</b> for team distribution and <b>STAFF-PILOT.md</b> to record two first-time installations before wider rollout.</p>
<p><a href="https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop">Claude extension installation help</a></p></html>\n`;
}

export async function buildDesktopPackages(outputDirectory = join(repository, "build", "claude-desktop")) {
  await checkRelease(repository);
  const packageInfo = await json(join(repository, "package.json"));
  const manifest = await json(join(repository, "desktop-extension", "manifest.json"));
  if (manifest.version !== packageInfo.version) throw new Error("Desktop manifest and package versions must match.");
  const bundled = await build({
    absWorkingDir: repository,
    entryPoints: ["server.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    metafile: true,
    legalComments: "eof",
    logLevel: "silent",
  });
  const bytes = async (path) => new Uint8Array(await readFile(join(repository, path)));
  const text = (value) => new TextEncoder().encode(value);
  const license = await bytes("LICENSE");
  const install = await bytes("docs/claude-desktop.md");
  const deployment = await bytes("docs/team-deployment.md");
  const pilot = await bytes("docs/staff-pilot.md");
  const campaignGuide = await bytes("docs/campaign-studio.md");
  const imageGuide = await bytes("docs/image-provider.md");
  const extension = archive({
    "manifest.json": text(`${JSON.stringify(manifest, null, 2)}\n`),
    "icon.png": await bytes("assets/icon.png"),
    "server/launcher.mjs": await bytes("desktop-extension/launcher.mjs"),
    "server/bridge.mjs": bundled.outputFiles[0].contents,
    "LICENSE": license,
    "THIRD_PARTY_NOTICES.txt": text(await dependencyNotices(bundled.metafile.inputs)),
    "INSTALL.md": install,
    "CAMPAIGN-STUDIO.md": campaignGuide,
    "IMAGE-PROVIDER.md": imageGuide,
  });
  const pluginFiles = {
    "figma-local-bridge/manifest.json": await bytes("plugin/manifest.json"),
    "figma-local-bridge/code.js": await bytes("plugin/code.js"),
    "figma-local-bridge/ui.html": await bytes("plugin/ui.html"),
    "figma-local-bridge/LICENSE": license,
    "figma-local-bridge/INSTALL.md": install,
  };
  const plugin = archive(pluginFiles);
  const extensionName = `figma-local-bridge-${packageInfo.version}.mcpb`;
  const pluginName = `figma-local-bridge-figma-plugin-${packageInfo.version}.zip`;
  const kitName = `figma-local-bridge-staff-kit-${packageInfo.version}.zip`;
  const checksums = [[extensionName, extension], [pluginName, plugin]].map(([name, value]) => `${createHash("sha256").update(value).digest("hex")}  ${name}\n`).join("");
  const release = text(`${JSON.stringify({
    schemaVersion: 1,
    version: packageInfo.version,
    platforms: manifest.compatibility.platforms,
    signing: "unsigned",
    updates: "Install both matching packages; private file installs require manual updates.",
    packages: [
      { component: "claude-desktop", file: extensionName, sha256: createHash("sha256").update(extension).digest("hex") },
      { component: "figma-plugin", file: pluginName, sha256: createHash("sha256").update(plugin).digest("hex") },
    ],
  }, null, 2)}\n`);
  const instructions = text(staffInstructions(extensionName));
  const kit = archive({
    [extensionName]: extension,
    ...pluginFiles,
    "START-HERE.html": instructions,
    "INSTALL.md": install,
    "TEAM-DEPLOYMENT.md": deployment,
    "STAFF-PILOT.md": pilot,
    "CAMPAIGN-STUDIO.md": campaignGuide,
    "IMAGE-PROVIDER.md": imageGuide,
    "RELEASE.json": release,
    "SHA256SUMS.txt": text(checksums.split("\n").filter((line) => line.endsWith(extensionName)).join("\n") + "\n"),
  });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, extensionName), extension);
  await writeFile(join(outputDirectory, pluginName), plugin);
  await writeFile(join(outputDirectory, kitName), kit);
  await writeFile(join(outputDirectory, "INSTALL.md"), install);
  await writeFile(join(outputDirectory, "TEAM-DEPLOYMENT.md"), deployment);
  await writeFile(join(outputDirectory, "STAFF-PILOT.md"), pilot);
  await writeFile(join(outputDirectory, "CAMPAIGN-STUDIO.md"), campaignGuide);
  await writeFile(join(outputDirectory, "IMAGE-PROVIDER.md"), imageGuide);
  await writeFile(join(outputDirectory, "RELEASE.json"), release);
  await writeFile(join(outputDirectory, "START-HERE.html"), instructions);
  await writeFile(join(outputDirectory, "SHA256SUMS.txt"), checksums + `${createHash("sha256").update(kit).digest("hex")}  ${kitName}\n`);
  return { extension: join(outputDirectory, extensionName), plugin: join(outputDirectory, pluginName), kit: join(outputDirectory, kitName), version: packageInfo.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output-dir")) throw new Error("Use --output-dir /path/to/output, or no arguments.");
  const result = await buildDesktopPackages(args.length ? resolve(args[1]) : undefined);
  console.log(`Built Claude Desktop extension: ${result.extension}`);
  console.log(`Built companion Figma plugin: ${result.plugin}`);
  console.log(`Built staff download kit: ${result.kit}`);
}
