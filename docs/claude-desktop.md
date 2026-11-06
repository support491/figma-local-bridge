# Use Figma Local Bridge with Claude Desktop

For Claude Desktop and Figma Desktop on a Mac. This package works with your team's Claude Personal and Figma Professional setup. Arsenio provides one staff-kit ZIP containing both parts; you do not need GitHub, Terminal, npm, a separate Node.js installation, or a Figma API token.

## Install once

1. Download the staff-kit ZIP from Arsenio's team download folder. Double-click the ZIP, then open **START-HERE.html** for the short setup walkthrough.
2. Open Claude Desktop. Go to **Settings → Desktop app → Extensions → Manage**. Older layouts show **Settings → Extensions**.
3. Open **Advanced settings**, choose **Install Extension…**, and select the file ending in **.mcpb** from the extracted staff kit. Keep its extension; do not unzip the `.mcpb` itself.
4. Review and install it. This is an unsigned private build. If your Mac or Claude blocks it, send the message to Arsenio; do not disable your company's security controls.
5. Start a regular Claude chat. Under **+ → Connectors**, enable **Figma Local Bridge** if needed. Completely quit Claude with **Command Q** and reopen it if prompted.
6. Move the extracted **figma-local-bridge** folder to a permanent location, such as Documents. Keep it there after installation.
7. In Figma Desktop, open a Figma Design file you can edit. Choose **Plugins → Development → Import plugin from manifest…**.
8. Select **manifest.json** inside the folder you moved, then click **Open**.

Claude starts the local bridge automatically. The Figma plugin is a separate one-time installation. Opening the Claude extension alone does not install the Figma half.

## Start your first task

1. Open the intended Figma file and run **Plugins → Development → Local MCP Bridge**. Leave its panel open.
2. Check the file and page shown in the welcome screen. Use **Check connection** if the bridge is unavailable or versions do not match.
3. Choose the task to check your file and click **Copy instructions for Claude**. Paste into a regular Claude Desktop chat.
4. Read Claude's file and page confirmation. It should match what you see in Figma before you ask it to edit anything.
5. Select the whole artboard, group, or section you want to edit in Figma. It must sit directly on the page; select its outer frame rather than an individual headline or image. Click **Work on a copy** to duplicate the selected design immediately. The copy becomes selected; your original stays in place.
6. Choose a task, enter your details, then click **Copy instructions for Claude** again. Paste the fresh message into Claude.
7. Review Claude's tool requests and check the finished design in Figma.

The task options help you check the file, change a headline, create a campaign variation, or export selected graphics. These are prompt templates: Claude carries out the task after you paste and send the instructions. The file/page and selection are captured for that prompt. Copy fresh instructions after changing pages, changing the selection, or restarting the plugin.

Example task details:

> Change the headline to “Your summer starts here”. Keep the current fonts, colours, and layout. Check that the new text fits.

**Work on a copy** creates ordinary Figma duplicates. The generated instructions identify the copies, but they are not a technical permission boundary around Claude's tools. Check Claude's proposed edits and the result. Select the copy before each new task if you want to continue working on it.

## Undo an edit

Click the Figma canvas and press **Command Z**. Check the result after each press. A Claude task can involve several separate edits, so one undo may not reverse the entire task. You can also delete a working copy when you no longer need it; keep the original until you approve the result.

## Each day

Open Claude, open your Figma file, run **Local MCP Bridge**, and leave its panel open. Check the displayed file and page. Choose a task and copy its instructions into Claude.

The bridge stops when Claude closes if the extension owns it. A separately managed background owner keeps running. A green bridge status confirms the local connection; it does not prove that a specific Claude chat has enabled the connector. Ask Claude to check the file to verify the complete connection.

This package is for regular Claude Desktop chats. Local servers configured this way are unavailable in Claude's website and Cowork.

## If something is not working

Use **Check connection** first. It distinguishes a stopped bridge, a disconnected plugin, and a version mismatch, and tells you what to do next.

- **Claude does not show the tools:** completely quit and reopen Claude, then check that the extension and chat connector are enabled.
- **Figma cannot connect:** open Claude and enable the extension. Close and rerun Local MCP Bridge. If it still fails, copy the support details for Arsenio.
- **Versions do not match:** install both parts from the same staff kit using the update steps below. A separately managed background service may need Arsenio to update it.
- **The wrong file or page appears:** switch to the intended file/page, run the plugin there, and copy new instructions.
- **Copying a design fails:** check that the file is editable and select the intended design again. The plugin reports the failure; do not assume a copy was created.

The **Copy support details** action copies diagnostic information for you to review and share. Nothing is sent automatically. The report excludes design content, file links, and local filesystem paths.

Advanced settings retain the optional saved connection name/link, connected-file inspector, and technical references. Staff can use the welcome screen without entering them. Keep API and comment access disabled.

## Update both parts together

1. Finish the current task, then close the Figma plugin panel and completely quit Claude.
2. Download the latest approved staff kit from the same team download folder. Keep the old kit until the new version works.
3. Reopen Claude and install the new `.mcpb` using the installation steps above. If prompted, restart Claude.
4. Replace the **code.js**, **ui.html**, and **manifest.json** in your permanent Figma plugin folder with the matching files from the new kit. Keep the permanent folder at the same location.
5. Rerun Local MCP Bridge in Figma. Use **Check connection** and confirm the bridge and plugin versions match.
6. Copy the check-file instructions into Claude and verify the expected file/page before editing.

Private file installations require manual updates. The package does not silently replace a background service or download an update. Arsenio can use **RELEASE.json** and **SHA256SUMS.txt** to identify and check the matching packages. Preferences and exported PNGs are stored outside the package and remain when it is replaced.

## If you already used a manual Claude installation

Disable the previous manually configured `figma_local` connection before enabling the extension, so Claude does not show duplicate tools. Keep existing preferences and saved Figma connection details. An administrator must update any separately managed bridge owner to this release; the extension does not stop or replace it.

## For Arsenio and maintainers

See **TEAM-DEPLOYMENT.md** in the staff kit (or [team-deployment.md](team-deployment.md) in the repository) for the shared download and release process. Use **STAFF-PILOT.md** (or [staff-pilot.md](staff-pilot.md)) to record two first-time installations.

Run `npm ci`, `npm run check`, and `npm run package:desktop` to create packages under `build/claude-desktop/`. The build checks that all component versions match, compiles from source, includes dependency notices, and uses an explicit file list that excludes local settings and credentials. Package tests exercise the extracted distribution on an isolated port with a simulated Figma plugin; the staff pilot is the separate live-app check.

The launcher enforces disabled Figma API/comment access. It starts a bridge owner or reuses an existing one, without installing a launch agent or rewriting Claude settings. The bridge binds to loopback and assumes a trusted local computer; it is not isolated from other processes running as the same OS user. Requests and design data used by Claude remain subject to your Claude account's data handling settings.

Arsenio Aaron's distribution of David Buck's MIT-licensed Figma Local Bridge includes both copyright notices and the complete license.

References: [Claude Desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [local and remote Claude connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [MCPB specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md).
