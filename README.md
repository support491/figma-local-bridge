# Figma Local Bridge

<img src="assets/icon.png" alt="Figma Local Bridge icon" width="64" height="64">

Inspect and edit the Figma Design files open in Figma Desktop through local MCP tools. A development plugin performs canvas operations through Figma's Plugin API, while a local Node.js server relays named, validated commands. Canvas work needs no personal access token, Figma REST API calls, or hosted Figma MCP connector.

This is the [support491 local fork](https://github.com/support491/figma-local-bridge) of [david-buck/figma-local-bridge](https://github.com/david-buck/figma-local-bridge), based on upstream **0.14.2**. The current local version is **0.14.2-local.5**. It adds Campaign Studio for Claude Desktop, a staff installer, a persistent macOS service, independent file connections, resumable text audits, and local font/design-system tools. The setup below keeps comment tools and Figma API access disabled.

See the [workflow and tool reference](docs/reference.md), [inspect-first workflow skill](skills/figma-local-workflow/SKILL.md), and [changelog](CHANGELOG.md) for more detail.

## What it can do

- Discover connected files, pages, artboards, selections, components, styles, and variables.
- Read ordered copy, update identified text layers, audit overflow and clipping, and export PNGs locally.
- Create and edit native frames, sections, shapes, text, component instances, auto-layout, and bound colour tokens.
- Inventory fonts, preview font replacements, and update local text styles or variable values with dry-run support.
- Compose replacement layouts with progress tracking, required-image checks, recovery IDs, and verified archival of previous content.
- Keep several Figma files connected while each assistant explicitly targets its own work.

The bridge accepts controlled commands; it does not execute JavaScript supplied by an agent.

## Requirements

- **Figma Desktop** with a Figma Design file open and permission to run a development plugin. The included manifest targets the Design editor.
- **Node.js 20 or newer**, available to the MCP client and the background service.
- An MCP client such as Codex or Claude Code.
- **macOS** for the included `launchd` service installer. A foreground owner can also be started manually.

The repository includes the bundled `dist/server.mjs`. A fresh clone can run it without installing npm dependencies. Install dependencies only when building or testing from source.

## Claude Desktop staff package

For staff using regular Claude Desktop on Mac, distribute the prebuilt `.mcpb` extension and companion Figma plugin, or the single staff-kit ZIP containing both parts and **START-HERE.html**. Follow the [staff installation guide](docs/claude-desktop.md). Staff do not need GitHub access, npm, a separate Node.js installation, or manual Claude JSON settings. The extension starts the local bridge with Claude and keeps API/comment access disabled.

The welcome screen shows the current file and page. Staff choose a marketing task and use **Copy instructions for Claude** to prepare a prompt with the intended connection and selection. **Work on a copy** duplicates the selection before editing. **Check connection** explains connection and version problems, and **Copy support details** prepares a report without design content, file URLs, or local paths. Technical references remain in Advanced settings.

For Claude Personal and Figma Professional, use the downloadable kit and one shared team download folder. The [team deployment guide](docs/team-deployment.md) covers releases, updates, rollback, and optional organization publishing if eligible plans are available. The [staff pilot checklist](docs/staff-pilot.md) records two first-time installations in the real apps.

Maintainers can run `npm ci`, `npm run check`, then `npm run package:desktop` to generate matching packages under `build/claude-desktop/`. Builds reject mismatched versions and include **RELEASE.json**, hashes, and the administrator/pilot guides. Pull requests run package checks; pushing a matching `vVERSION` tag runs tests and publishes the paired downloads in one GitHub release. The `.mcpb` remains unsigned. It is separate from the proxy-only Codex/Claude Code plugin manifests; the existing persistent-service workflow below remains available.

## Quick start

### Campaign Studio for marketing staff

Open **Campaign Studio** in the plugin to save/import an approved brand kit, fill in a campaign brief, and prepare three editable concept workspaces. Copy the brief into Claude Desktop to develop the product, promotional, and editorial directions. The plugin prepares native working copies; Claude performs the AI design work.

Claude reviews rendered concept previews alongside measurable checks, records feedback against the current version, and asks you to choose and approve. Save a checkpoint before further revisions, restore it as a new draft, adapt an approved concept to campaign sizes, then review and approve those variants before export. While the campaign is active, the plugin restricts bridge edits to its drafts and protects the source and approved artwork. **Finish campaign** explicitly releases that restriction and preserves history.

Brand kits are portable JSON files with colours, fonts, voice, rules, reference designs, and template role mappings. Share the approved file with staff; imported Figma node references must be verified or relinked in each destination document. Campaign state is saved with the Figma document. It is not a central team account or an automatic learning system.

See the [plain-language campaign walkthrough](docs/campaign-studio.md) and [optional image setup](docs/image-provider.md). Image generation/editing is disabled by default, uses a separately configured and billed provider, and requires approval for each request. Ordinary campaign work needs no image API key. Figma canvas operations still use the local bridge; AI requests are processed by Claude and, if enabled, the image provider.

### 1. Clone this fork

```sh
mkdir -p "$HOME/Developer"
git clone https://github.com/support491/figma-local-bridge.git "$HOME/Developer/figma-local-bridge"
cd "$HOME/Developer/figma-local-bridge"
```

If that directory already exists, choose a different destination to keep the existing checkout. Use the new checkout's absolute path in all client and plugin settings.

### 2. Import the Figma plugin

In Figma Desktop, choose **Plugins → Development → Import plugin from manifest…** and select [`plugin/manifest.json`](plugin/manifest.json) from your checkout.

### 3. Start one persistent owner

On macOS, run these commands from the checkout:

```sh
node scripts/service.mjs install
node scripts/service.mjs start
node scripts/service.mjs status
```

The per-user launch agent starts at login and restarts after an exit. It runs `dist/server.mjs --http-owner` on **127.0.0.1:3846**, independently of assistant sessions. The service disables Figma API/comment access, clears token/file-key environment values, and uses memory-only credential storage.

Only one owner should use this endpoint. Stop an earlier bridge owner before starting the service; the installer does not kill other processes. The service label is shared across checkouts, so installing from a second clone replaces the installed service paths. To inspect the proposed configuration without changing the service, run:

```sh
node scripts/service.mjs install --dry-run
```

For a foreground owner instead of the macOS service, keep this process running in a terminal:

```sh
FIGMA_BRIDGE_API_DISABLED=1 node dist/server.mjs --http-owner
```

Keep the default endpoint: the plugin transport and manifest expect `localhost:3846`.

### 4. Connect your MCP client

Each client runs a **stdio proxy** to the owner. Use the absolute path to your checkout and keep `--proxy-only`; closing the client then leaves the owner and Figma connections running.

For Codex, the repository includes a [plugin manifest](.codex-plugin/plugin.json) and [MCP configuration](.mcp.json). For manual configuration, add the following to `~/.codex/config.toml` (see the [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)):

```toml
[mcp_servers.figma_local]
command = "node"
args = ["/ABSOLUTE/PATH/TO/figma-local-bridge/dist/server.mjs", "--proxy-only"]

[mcp_servers.figma_local.env]
FIGMA_BRIDGE_API_DISABLED = "1"
```

For Claude Code, use the included [plugin manifest](.claude-plugin/plugin.json), or register the server manually using its [stdio setup](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server):

```sh
claude mcp add --scope user --env FIGMA_BRIDGE_API_DISABLED=1 \
  --transport stdio figma-local -- \
  node /ABSOLUTE/PATH/TO/figma-local-bridge/dist/server.mjs --proxy-only
```

Set `FIGMA_BRIDGE_API_DISABLED=1` in **every client**, as well as the owner. A proxy advertises tools from its own environment; disabling the owner alone does not hide comment tools in the client. Both packaged MCP configurations already include this setting.

Restart the client's MCP process after adding or changing its configuration. If the app cannot find `node`, use its absolute executable path.

### 5. Open and verify the target file

1. Open the intended Figma Design file and run **Plugins → Development → Local MCP Bridge**. Leave its panel open.
2. Confirm the current file/page in the welcome screen. Optionally open **Advanced settings → Connected files** to save a connection name and the file's HTTPS link.
3. Call `figma_bridge_status` first. Verify bridge/plugin versions, connection health, and the intended file and page.
4. Call `figma_list_connections` to discover the connection's target references. Pass the chosen `targetId` to canvas calls.

If no plugin is connected, run **Local MCP Bridge** in the target desktop file and keep its panel open. The local status page is available at [localhost:3846](http://localhost:3846/).

## Work with multiple files

Run the plugin in each file you want connected. Each file remembers its connection name and supplied HTTPS link in a small, private, namespaced document record; saving these details does not change visible canvas nodes. Clear both fields and save to forget them.

`figma_list_connections` returns runtime IDs and, when available, `namedTargetRefs` and `stableTargetRef`. Use a returned reference as `targetId`:

| Reference | Behaviour |
| --- | --- |
| Runtime `targetId` | Identifies one running plugin instance; rediscover it after a plugin restart. |
| `name:Design Library` | Matches an exact saved connection name or document name; it must be unique among operational connections. |
| `file:FILE_KEY` | Uses the supplied HTTPS file link and can survive plugin restarts. |

Names are exact matches, not fuzzy searches or page names. Missing, stale, or ambiguous references fail before dispatch. Selecting a Figma window or a row in the panel does not select an assistant's target.

A client may set `FIGMA_BRIDGE_TARGET` in its environment as a default. A per-call `targetId` overrides only that call, preserving the other client's default. Commands and composite calls are serialized per target; separate targets can progress independently.

The supplied file link is remembered metadata, not independently verified file identity. Duplicated files can inherit it, so update a copy's link before using a stable target. Avoid duplicate plugin runtimes for the same physical file: leases protect plugin instances, not every window of a document.

The **Connected files** picker in Advanced settings lists running connections. **Open file** opens a saved link but does not launch the bridge in that file. Panel view controls preserve the connection. The staff prompt always targets the file containing its own plugin panel; inspecting another connection in Advanced settings does not redirect that prompt.

## Review an artboard or spread

After verifying the target, call `figma_list_artboards` with its `targetId`. Then call `figma_prepare_review` with one to eight returned artboard IDs in reading order. Replace the sample name and IDs below with discovered values:

```json
{
  "targetId": "name:Design Library",
  "nodeIds": ["1:2", "1:3"],
  "auditOverflow": true,
  "detail": "summary"
}
```

The result contains ordered copy, overflow-audit results, and local PNG paths under `~/Pictures/Figma MCP Exports` by default. It leaves no document edits. A two-artboard review gathers copy and audits in one packaged plugin operation, followed by two exports. Use structured reads and audits for copy-only work that does not need images.

An audit may be incomplete even when its current batch reports no warnings. Continue it before claiming verification.

### Continue a bounded text audit

`figma_audit_text_overflow` defaults to at most **40 text nodes**, **400 traversal nodes**, and a cooperative **1-second budget** per call. Each result contains the current batch's findings, cumulative `totals`, `complete`, and `nextCursor`.

When `complete` is false, pass `nextCursor` as `cursor` with the same target, current page, root `nodeId`, and `includeHidden`. Keep findings from every batch. Stop by not requesting another batch.

Cursors are single-use and expire after five minutes or a plugin restart. Start fresh after document edits. Budgets are bounded and cooperative; one native Figma font or measurement operation cannot be interrupted mid-call. Packaged reviews, copy updates, and compositions also report incomplete verification when their first audit batch is partial. Resume the audit, not the edits.

## Track a long composition

Use `figma_start_composition` with an explicit target when a board may take a while. It returns an operation ID immediately; `figma_operation_status` reports progress and the final result. Reuse the same operation ID with the same target and inputs to recover that request.

If a response is lost, check the recovery ID from the error before retrying. Do not start a duplicate while an operation is queued, running, or has an unknown outcome. History lives in memory; after a bridge restart, inspect the document if the ID is no longer known.

Composed frames and rectangles can reuse an existing image fill with `imageSourceNodeId`. Set `imageRequired: true` where an image is necessary. Missing, hidden, or transparent required images make `verificationComplete` false and prevent the previous layout from being archived.

Copying an inherited CROP image into a differently proportioned area switches it to centered FILL. Explicit crop modes and transforms are preserved. Review reported adjustments and the final focal point.

## Service management and local data

Run `node scripts/service.mjs ACTION` from the checkout:

| Action | Purpose |
| --- | --- |
| `install` | Write the launch-agent configuration using this checkout and a stable Homebrew Node path when available. |
| `start` | Load the installed service if it is not already loaded. |
| `status` | Report the loaded service's state and process ID. |
| `restart` | Restart the currently loaded configuration. |
| `stop` | Unload the service. |
| `uninstall` | Unload it and remove its launch-agent plist. |

The plist lives at `~/Library/LaunchAgents/com.figma-local-bridge.owner.plist`; logs are in `~/Library/Logs/FigmaLocalBridge/owner.stdout.log` and `owner.stderr.log`. Uninstalling the service does not remove the checkout, preferences, or exported PNGs.

Preferences default to `~/.figma-local-bridge`. To reuse a different store, pass `--preferences-dir /ABSOLUTE/PATH/TO/bridge-state` during installation and set `FIGMA_PREFERENCES_DIR` to that same directory in **every client's environment**. Preference tools run in the client process, so matching paths matter. Preserve an existing store when updating or moving the checkout. Set `FIGMA_EXPORT_DIR` in each exporting client's environment to change its PNG destination.

After changing service paths or settings, use **stop → install → start**. `restart` does not reload a changed plist. The installer also accepts `--node /ABSOLUTE/PATH/TO/node` and `--dry-run` for configuration inspection.

## Build, update, and test

For source development, install the locked dependencies:

```sh
npm ci
npm run check
```

`npm ci` runs the package's `prepare` script, which builds `dist/server.mjs`. After later server edits, rebuild explicitly:

```sh
npm run build
```

After pulling or building an update:

1. Restart the background service to load the updated server bundle. Use **stop → install → start** instead if its paths or settings changed.
2. If plugin code changed, close and run the development plugin again in each file. Saved connection details restore automatically; older runtime-only installations need them saved once.
3. Restart the MCP process in each client when tool schemas or client settings change.
4. Call `figma_bridge_status` and confirm the bridge and each plugin report the same version.

`npm run check` performs syntax checks and automated server, plugin, credential, panel, and service tests. These are separate from live Figma verification. For a live review check, use two known artboards and confirm ordered copy, two PNGs, and completed audits, continuing any partial batches.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Proxy cannot reach the owner | Run `node scripts/service.mjs status`, check the service logs, and open the local status page. A `--proxy-only` client never starts an owner. |
| Owner cannot bind to port 3846 | Another process may own the endpoint. Identify and stop the previous owner before starting this service. |
| No connected files | Run **Local MCP Bridge** in the intended Figma Desktop file and leave the panel open. Opening a saved link alone does not start the plugin. |
| Target is missing or ambiguous | Refresh `figma_list_connections`; use an exact unique reference or the returned runtime ID, and verify the file/page. |
| Bridge/plugin versions differ | Restart the owner and reload the development plugin; restart client MCP processes if their schemas changed. |
| Review is not verified | Continue every incomplete audit cursor and inspect the cumulative findings and required-image warnings. |
| Mutation timed out or its outcome is unknown | Check its operation status and inspect the affected document before retrying. See the [recovery guidance](docs/reference.md#concurrency-and-interrupted-calls). |
| Comment tools appear unexpectedly | Set `FIGMA_BRIDGE_API_DISABLED=1` in the client environment and restart its MCP process. Keep API access disabled in the owner too. |

## Local boundary and API access

The provided service and packaged MCP clients disable Figma API/comment tools with `FIGMA_BRIDGE_API_DISABLED=1`. This hides comment tools, blocks credential and REST routes, and bypasses credential lookup. No token is needed for canvas work. Keep the service's disabled API endpoint and credential settings in place; do not add a personal access token or enable API access as a canvas troubleshooting step.

The inherited optional-comment implementation remains in the source for separately authorized installations. It uses Figma REST credentials and is outside this fork's documented local setup.

The bridge binds to loopback, validates commands, and rejects scripts and event handlers in SVG imports. It assumes a trusted local computer and does not provide secret pairing or strong authentication against other local processes. See the [security model](docs/reference.md#security-model) for the boundary and limitations.

Licensed under the [MIT License](LICENSE).
