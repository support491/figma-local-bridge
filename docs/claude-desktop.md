# Install Figma Local Bridge in Claude Desktop

This staff package is for Claude Desktop and Figma Desktop on a Mac. Claude supplies the Node.js runtime, and the extension includes the ready-to-run bridge and its dependencies.

## What you need

- Claude Desktop and Figma Desktop, both installed and signed in.
- The `.mcpb` extension file and companion Figma plugin ZIP from Arsenio, or the staff-kit ZIP containing both parts and **START-HERE.html**. Unzip the staff kit and open **START-HERE.html** for the shortest setup walkthrough.
- Permission to edit the Figma Design files you want to work on.

You do not need GitHub access, Terminal commands, npm, a separate Node.js installation, or a Figma API token to use these packages.

## Install the Claude extension once

1. Save the `.mcpb` file on your Mac. Keep its `.mcpb` extension; you do not need to unzip it.
2. Open Claude Desktop. Go to **Settings → Desktop app → Extensions → Manage**. Older Claude layouts show **Settings → Extensions**.
3. Open **Advanced settings**, click **Install Extension…**, and choose the `.mcpb` file.
4. Review the extension details and approve installation if it is the package you received from Arsenio. This private build is unsigned; your organization's policy may require an administrator to approve it.
5. Start a regular Claude chat. Under **+ → Connectors**, look for **Figma Local Bridge** and enable it if needed.

Claude starts the bridge automatically when it loads the extension. If Claude asks you to restart, completely quit it with **Command Q**, then reopen it.

## Install the Figma plugin once

1. Unzip the companion Figma plugin ZIP. Move the extracted **figma-local-bridge** folder somewhere permanent, such as a folder in Documents. Keep it there after installation.
2. Open Figma Desktop and a Figma Design file you can edit.
3. Choose **Plugins → Development → Import plugin from manifest…**.
4. Select **manifest.json** inside the extracted folder and click **Open**.

Installing the Claude extension does not install the Figma plugin. These are two separate, one-time installations. An organization-published Figma version, if provided by your administrator, can replace the manual import.

## Connect a file and start working

1. In the Figma file, run **Plugins → Development → Local MCP Bridge**. Leave its panel open while you work.
2. Check that the panel says **Connected**. Click **Expand**, then **Connected files**. Give the connection a clear name, such as **Marketing Campaign**. Paste the file link from Figma's Share menu and click **Save connection details**.
3. In a regular Claude Desktop chat, paste this message, replacing the connection name if needed:

> Use the Figma Local Bridge tools. First call figma_bridge_status, then figma_list_connections. Confirm the connection named "Marketing Campaign" and its current page. List the artboards on that page. Do not change anything yet. Keep Figma API and comment access disabled.

4. Once Claude confirms the correct file and page, give it one clear task. Review tool requests before approving them, and check the result in Figma.

Example request:

> On the artboard named "Summer Sale", change the headline to "Your summer starts here". Keep the current fonts, colours, and layout. Check that the new text fits, then tell me what changed.

## Each day

Open Claude Desktop, open your Figma file, and run **Local MCP Bridge** in that file. Ask Claude to confirm the file and page, then describe your task. Saved connection details return automatically. If you duplicate a file, update its saved name and link.

The bridge starts with Claude and stops when Claude closes if the extension owns it. A separately managed background owner keeps running. The Figma plugin panel must stay open during work. This package is for regular Claude Desktop chats; local servers configured this way are unavailable in Claude's website and Cowork.

## If you already used the manual installation

Disable the old manually configured Claude `figma_local` connection before enabling the extension, so Claude does not show two copies of the same tools. Keep your existing preferences and Figma connection details. An administrator should update any separately managed owner to this release before reusing it; the extension does not stop or replace a running service. Bridge and Figma plugin versions should match.

## If something is not working

- **The extension cannot be installed:** check with your Claude administrator; private extension policies may block unsigned files.
- **Claude does not show the tools:** completely quit and reopen Claude, then check the extension's enabled state and error message in Settings.
- **Figma says Connecting:** open Claude and enable the extension. Close and run the Figma plugin again. If it still fails, send Arsenio the exact error; another service or a mismatched bridge may be using the local endpoint.
- **Claude sees several files:** give it the saved connection name and ask it to confirm the file and page before editing.

Keep API and comment access disabled. This package enforces that policy in its launcher and does not request or save Figma API credentials. The bridge binds to loopback and assumes a trusted local computer; it is not isolated from other processes running as your OS user.

## Updates

For a new private release, install the replacement `.mcpb` from Arsenio and reload the updated companion Figma plugin. Private file installations require installing updates manually. The bridge's preference folder and PNG export folder are outside the extension package and are preserved when it is replaced.

## For the person building the staff package

Run `npm ci`, then `npm run package:desktop`. The build creates a versioned `.mcpb`, a companion Figma plugin ZIP, a combined staff-kit ZIP, installation instructions, and SHA-256 checksums under `build/claude-desktop/`. The build compiles the server from source, includes dependency license notices, and archives an explicit file list; local settings and credentials are excluded. `npm run check:desktop` builds and exercises the extracted distribution on an isolated port with a simulated Figma plugin.

The `.mcpb` uses manifest specification 0.3 and Claude's Node runtime (Node 20 or newer). Unlike the existing proxy-only Codex/Claude Code configuration, its launcher uses normal stdio mode: it starts the local owner if available or connects to an existing owner. The launcher forces API access off and clears process-local token settings before importing the bundled server. It does not install a launch agent, rewrite Claude's manual config, or change the running bridge.

Source and licensing: this package is Arsenio Aaron's distribution of the MIT-licensed local fork, based on David Buck's Figma Local Bridge. Both copyright notices and the complete license are included.

References: [Claude Desktop extension installation](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [MCPB specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md), and [local versus remote Claude connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
