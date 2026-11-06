# Give Figma Local Bridge to your team

The current deployment is a downloadable staff kit for Mac, using Claude Personal and Figma Professional. Each person installs the Claude extension and imports the Figma plugin once. No plan upgrade, GitHub account, terminal commands, or separate Node installation is required for staff.

## Set up one team download location

1. Build or download the approved versioned staff-kit ZIP. Use the whole ZIP so its Claude and Figma parts stay together.
2. Put it in a shared company folder that your staff can access. Keep the folder link the same across releases. A private GitHub repository's release page requires repository access, so do not make that the only staff download route.
3. Add a short note beside the download: “Download this ZIP, unzip it, and open START-HERE.html. For help, contact Arsenio.” Include the approved version and date.
4. Keep an **Older versions** folder for rollback. Keep only the current approved kit in the main folder.
5. Use STAFF-PILOT.md with two staff members. After both complete the pilot, distribute the same folder link to the rest of the team.

These repository changes prepare the kit and release automation. They do not create a shared company folder, send staff messages, install software on staff computers, or complete the pilot.

## Build and publish a coordinated release

From a clean checkout of the reviewed commit:

```sh
npm ci
npm run check
node scripts/check-release.mjs
npm run package:desktop
```

The output folder `build/claude-desktop/` contains:

| File | Purpose |
| --- | --- |
| `figma-local-bridge-staff-kit-VERSION.zip` | Staff download containing both parts and instructions. |
| `figma-local-bridge-VERSION.mcpb` | Claude Desktop extension alone. |
| `figma-local-bridge-figma-plugin-VERSION.zip` | Matching Figma development plugin alone. |
| `START-HERE.html` and `INSTALL.md` | Staff setup and daily-use instructions. |
| `TEAM-DEPLOYMENT.md` and `STAFF-PILOT.md` | Administrator rollout guide and live test record. |
| `RELEASE.json` | Component version, supported platform, signing state, package names, and hashes. |
| `SHA256SUMS.txt` | SHA-256 checksums for the three release archives. |

The build refuses mismatched package, lockfile, MCP manifest, bridge runtime, or Figma plugin runtime versions. Update these together. The Figma manifest has no release-version field; the plugin's runtime version supplies that half of the check.

The **Check staff package** GitHub workflow runs tests and builds review artifacts for pull requests and pushes to main. The **Release staff package** workflow runs on version tags, tests again on macOS, verifies the tag against the package version, builds the matching files, and publishes one GitHub release. It does not upload anything to Claude or Figma.

When the reviewed release is ready, use its actual package version in this maintainer command:

```sh
git tag vVERSION
git push origin vVERSION
```

For example, a package version of `0.14.2-local.4` requires the tag `v0.14.2-local.4`. Only push a tag when you intend to publish that release. GitHub Actions must be enabled for this repository. Review the workflow result and download its staff kit, then place that exact kit in the team download folder.

To check downloaded archives on a Mac, put them beside SHA256SUMS.txt and run:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

The files currently remain **unsigned**. Checksums verify file integrity; they are not publisher signatures. If company policy requires a signed extension, obtain the organization's signing certificate and use the MCPB signing workflow before distribution. Signing must be followed by regenerating the kit and checksums from those signed bytes; do not present the current unsigned artifacts as signed.

## Update and rollback

For an update, provide a complete new kit, not a loose replacement script. Staff install the `.mcpb`, replace the three Figma files in their permanent plugin folder, and rerun the plugin. Private `.mcpb` file installations require manual updates. The panel shows version mismatches and instructions; it does not download or install software.

If a separately managed background bridge is running, update that owner before staff resume work. Closing Claude does not stop an owner managed by another application or service. Keep the loopback endpoint and disabled Figma API/comment settings unchanged.

If the pilot finds a blocking issue, finish or stop the current task and reinstall **both** parts from the previous approved kit. Reopen Claude and the Figma plugin, then run the check-file task again. Do not combine an older Figma plugin with the new bridge. Exported PNGs and bridge preferences live outside the extension package.

## Optional future organization distribution

The current Claude Personal and Figma Professional plans use the staff-kit route above. The following is an optional route if the organization already adopts eligible plans; it is not required to use this plugin.

**Claude Team or Enterprise:** an Owner or Primary Owner can upload a custom `.mcpb` and make it available through the organization's desktop extension controls. Use the approved artifact, then test installation from a staff account. Organization controls do not install the Figma plugin. Check current account UI and device policy before rollout. [Claude's extension administration guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

**Figma Organization or Enterprise:** publish a classic private plugin to the organization so staff can find it among internal plugins. The repository's `local-mcp-bridge-dev` manifest ID is a development placeholder, not an organization-owned published plugin ID. In Figma Desktop, create/register the classic plugin under the publishing account and retain the ID Figma assigns. Prepare a separate publishing copy of the plugin folder using that ID, with this release's `code.js` and `ui.html`, then choose **Publish to → your organization** in Figma's plugin publishing flow. Keep the localhost-only network allowlist. Run a pilot using the published version before removing development imports. [Figma's internal plugin guide](https://help.figma.com/hc/en-us/articles/4404228629655-Create-internal-plugins-for-an-organization), [classic plugin publishing](https://help.figma.com/hc/en-us/articles/360042293394-Publish-classic-plugins-to-the-Figma-Community).

Publishing plugin assets through Figma's UI does not require enabling this bridge's REST API or comment tools. No organization plugin or extension is published by the build scripts.
