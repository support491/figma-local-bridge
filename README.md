# Local Figma MCP bridge

<img src="assets/icon.png" alt="Figma Local Bridge icon" width="64" height="64">

Use MCP tools to inspect and edit the Figma Design file open in Figma Desktop. A local Figma plugin performs canvas operations through the Plugin API; the MCP server relays named, validated commands to it. Canvas work needs no Figma API token. Comments are optional and use Figma's REST API.

The bridge can read artboards and copy, inspect layout and design-system assets, audit text fit, export PNGs, and make controlled edits to native Figma nodes. This local build keeps multiple plugin connections and routes each operation to an explicit target. It never runs JavaScript supplied by an agent. See the [tool and workflow reference](docs/reference.md) for the full list.

## Persistent local setup

This local build preserves the custom design-system and font tools and incorporates upstream 0.14.2. Run one HTTP owner independently of assistant sessions, then connect Claude Code and Codex as stdio proxies:

```sh
npm run build
node scripts/service.mjs install --preferences-dir /ABSOLUTE/PATH/TO/bridge-state
node scripts/service.mjs start
```

On macOS, the per-user launch agent starts the owner at login and restarts it after an exit. It listens only on `127.0.0.1:3846`. The installer uses a stable Homebrew Node path when available. `node scripts/service.mjs status`, `stop`, `restart`, and `uninstall` manage this service. Stop an earlier stdio-owned bridge before starting the service; the installer does not kill other processes.

After changing service paths or environment settings, run `stop`, then `install` with the desired options, then `start`. `restart` restarts the already loaded configuration; it does not reload a changed plist.

Configure each MCP client with `node /ABSOLUTE/PATH/TO/figma-local-bridge/dist/server.mjs --proxy-only`. The packaged MCP manifests use this mode. `FIGMA_BRIDGE_API_DISABLED=1` hides comment tools and disables optional API credentials and REST access; the local service sets it along with the existing disabled API endpoint and memory-only credential backend.

Open Local MCP Bridge in each Figma file and leave each panel open. Enter its connection name and HTTPS Figma file link, then choose **Save connection details** once. The plugin stores a small, hidden, namespaced record with that Figma file and restores it before connecting the next time the plugin runs. Each file keeps its own details; no REST token or private Figma API access is needed. Clear both fields and save to forget the stored details.

Copied or duplicated files can inherit this hidden record. Check and update the copy's file link before using a pinned assistant connection. The supplied link is remembered metadata, not independently verified file identity.

Call `figma_list_connections`, verify the intended file/page, and pass a runtime ID, `file:FILE_KEY`, or `name:Saved file name` as `targetId`. For example, `targetId: "name:Hims Design"` selects that saved connection name. Names match exactly and must be unique among connected files; missing, stale or ambiguous matches fail before dispatch. Discovery returns `namedTargetRefs` and `stableTargetRef`. A per-call target overrides only that call, preserving each proxy’s `FIGMA_BRIDGE_TARGET` default and the other assistant’s file. File references use the saved HTTPS link and survive plugin restarts.

The panel's connected-files picker shows each target, its status, and a copyable target ID. Selecting a row does not change a shared assistant default. **Open file** opens its supplied HTTPS link; it does not launch the bridge in a file that has no running plugin. Use Figma's desktop-link preference when you want those links to open in Desktop.

The panel starts compact with the saved file name, connection state and current activity. Choose **Expand** for connection controls and **Compact** to return to the dock. Switching views does not reconnect; the preference is remembered on this device.

Commands and composite calls are serialized per target. Separate targets can progress independently. Avoid opening duplicate bridge runtimes for the same underlying file: without reliable file identity, leases protect plugin instances, not duplicate windows of the same document.

## Bounded text audits

`figma_audit_text_overflow` measures up to 40 text nodes, visits up to 400 nodes, and uses a cooperative 1-second budget per call by default. It yields between small chunks so Figma can respond. Each result contains this batch’s findings, cumulative `totals`, `complete`, and `nextCursor`. If incomplete, pass the cursor with the same target, root `nodeId`, and `includeHidden`; stop by not requesting another batch. Keep previous batches’ findings and never interpret partial zero-warning results as a completed clean audit.

Cursors expire after five minutes or a plugin restart and are consumed once. Start fresh after edits. Budgets are configurable within bounded limits; a single Figma font or measurement operation cannot be interrupted mid-call. Packaged copy updates, compositions and reviews also report incomplete verification when their first audit batch is partial. Resume the audit, not the edits.

## Quick start

1. Clone this repository or download a release ZIP. Node 20 or newer runs the included `dist/server.mjs`; a build is not required for the committed bundle.
2. In Figma Desktop, choose **Plugins → Development → Import plugin from manifest…** and select [`plugin/manifest.json`](plugin/manifest.json).
3. Start the persistent local service above, then configure your MCP client to run `node /ABSOLUTE/PATH/TO/figma-local-bridge/dist/server.mjs --proxy-only`. For Codex, install this folder as a plugin or add:

   ```toml
   [mcp_servers.figma_local]
   command = "node"
   args = ["/ABSOLUTE/PATH/TO/figma-local-bridge/dist/server.mjs", "--proxy-only"]
   ```

4. Open the target Figma file and run **Plugins → Development → Local MCP Bridge**. Leave its status panel open.
5. Call `figma_list_connections`. Check the expected connection label and page, then pass its `targetId` to canvas calls.

Claude Code can use the same server with `claude mcp add --scope user figma-local -- node /ABSOLUTE/PATH/TO/figma-local-bridge/dist/server.mjs --proxy-only`. The repository also includes Codex and Claude plugin manifests and the [inspect-first workflow skill](skills/figma-local-workflow/SKILL.md).

## Review an artboard or spread

Call `figma_list_artboards` to get IDs, then call `figma_prepare_review` with one to eight IDs in reading order. For example:

```json
{"nodeIds":["1:2","1:3"],"auditOverflow":true}
```

The result contains ordered copy, optional overflow audits, and local PNG paths under `~/Pictures/Figma MCP Exports` by default. It leaves no document edits. Use the individual read and audit tools for copy-only work that does not need images.

In **0.13.1**, the review call gathers copy and overflow results in one packaged plugin operation, followed by one PNG export command per artboard. A two-artboard review with audits uses three plugin commands instead of five; the MCP tool name and output shape stay the same. See the [changelog](CHANGELOG.md).

## Track a long composition

Use `figma_start_composition` when a board may take a while. It returns an operation ID immediately; `figma_operation_status` reports the current phase and percentage, then the verified result. Reusing the same operation ID resumes that request instead of creating a duplicate.

If a response is lost, the error includes the recovery ID. Check it before retrying. Operation history lives in memory; after a bridge restart, inspect the document if that ID is no longer known.

Composed frames and rectangles can copy an existing Figma image fill with `imageSourceNodeId`. Mark an expected image area with `imageRequired: true`; a missing, hidden or transparent required image makes `verificationComplete` false and prevents the previous layout from being archived.

When an inherited CROP image is copied into a differently proportioned area, it switches to centered FILL to keep its proportions. Explicit crop modes and transforms remain your choice. The result reports automatic adjustments so you can review the focal point.

## Update or test

After updating server code, rebuild and restart the background service. Existing upgraded plugins reconnect automatically. After updating plugin code, close and run the development plugin again in each file. Saved connection details restore automatically; when upgrading from the earlier runtime-only version, enter and save each file's details once. Restart the `figma_local` MCP process in your client when tool schemas or client configuration change. Check `figma_bridge_status`: both bridge and plugin should report the same version. The local status page is at [localhost:3846](http://localhost:3846/).

To build and run local checks from source:

```bash
npm ci
npm run build
npm run check
```

For a live check, run `figma_prepare_review` on two known artboards and confirm ordered copy, two PNG files, and two audits. The packaged read should appear as one plugin activity, followed by two exports. A live Figma-file check is separate from the local automated tests.

## Optional comments and safety

Canvas tools stay local to `127.0.0.1`. The bridge accepts separately targeted Figma plugins and does not execute agent-written JavaScript. SVG imports reject scripts and event handlers. This is a trusted-local-computer boundary, not strong authentication against other local processes. Other processes running as your OS user can access the bridge while it is open.

This user's service and client configurations intentionally disable comment/API access. Canvas work does not require enabling it. The inherited optional-comment implementation is retained for compatibility but is blocked when `FIGMA_BRIDGE_API_DISABLED=1`.
