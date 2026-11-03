# Set up Claude and Figma on your Mac

A step by step guide for the marketing team

Follow this guide once on each Mac. It starts with downloading the project and ends with asking Claude to make a small change in Figma. The everyday checklist is at the end.

A **repository**, or **repo**, is the folder containing this project's files. **Dependencies** are the helper software the project needs. You will install them with one command.

Use **Claude Desktop in a regular chat** and **Figma Desktop**. Claude can explain the setup and help interpret errors. You will paste the installation commands into the Mac's **Terminal** app. This guide does not assume Claude can already control your computer.

## Step 1 Install the three apps

1. Open [Claude's download page](https://claude.com/download), download the Mac desktop app, and follow the installer. Open Claude and sign in.
2. Open [Figma's download page](https://www.figma.com/downloads/), choose the Mac desktop app, and follow the installation instructions. Open Figma and sign in.
3. Open [Node.js downloads](https://nodejs.org/en/download). Choose the current **LTS** release, **macOS**, and **Installer .pkg**. Download and open the installer, then follow its prompts. Node.js includes **npm**, the tool that installs dependencies. This project needs Node.js 20 or newer; use the current LTS download.

If your work Mac requires an administrator password to install an app, ask your company's IT contact to approve that installation.

**You are ready when:** Claude and Figma open successfully, and the Node.js installer says installation is complete.

## Step 2 Download the repository

1. In your web browser, sign in to GitHub and open [the Figma Local Bridge repository](https://github.com/support491/figma-local-bridge).
2. If GitHub shows **404** or says you do not have access, ask Arsenio Aaron to give your GitHub account access. Continue when you can see the project files.
3. Above the file list, check that the branch says **main**.
4. Click the green **Code** button, then **Download ZIP**.
5. Open **Finder → Downloads**. Double-click the downloaded ZIP if your Mac has not already opened it. You should see a folder usually named **figma-local-bridge-main**.

**You are ready when:** the downloaded folder contains files named **README.md**, **package.json**, and **package-lock.json**, plus folders named **plugin** and **dist**.

## Step 3 Put the project in a permanent folder

1. In Finder, choose **Go → Home** from the top menu. This opens your own Mac user folder.
2. If there is no **Developer** folder, choose **File → New Folder** and name it **Developer**.
3. Move the extracted project folder from Downloads into **Developer**.
4. Rename the project folder to **figma-local-bridge**, removing **-main** from the end.

The folder should now be **Home → Developer → figma-local-bridge**. Keep it there after setup: Claude and Figma will use files inside it. The ZIP download can stay in Downloads.

If a folder with that name already exists, check with Arsenio before replacing it. This guide is for a first installation.

## Step 4 Open Terminal and check Node.js

1. Press **Command Space** to open Spotlight, type **Terminal**, and press **Return**.
2. For each command below, copy the command exactly as shown, paste it into Terminal, and press **Return**. Wait for the command to finish before continuing. Do not type the dollar sign or other prompt already shown by Terminal.

Check Node.js:

```sh
node --version
```

Check npm:

```sh
npm --version
```

Each command should show a version number. Node's number starts with **v** and must be 20 or higher. If Terminal says **command not found**, quit Terminal, reopen it, and try again. If it still fails, return to the Node.js installation in Step 1.

## Step 5 Install the project dependencies

Tell Terminal which folder to work in. Paste this command and press Return:

```sh
cd "$HOME/Developer/figma-local-bridge"
```

Check that you are in the right place:

```sh
pwd
```

The result should end in **/Developer/figma-local-bridge**. If it does not, stop here and check Step 3.

Now install the dependencies:

```sh
npm ci
```

Wait until Terminal finishes and shows its normal prompt again. This downloads the project's listed dependencies. It also runs the project's build automatically, creating the ready-to-run bridge in **dist/server.mjs**.

**You are ready when:** the output includes the build completing and packages being added, with no failed command or **npm ERR!** message. Messages about funding are informational. Security advisories can appear even after a successful installation; send that summary to Arsenio to review rather than running **npm audit fix**, which can change the project's dependencies.

## Step 6 Start the background bridge

Keep using the same Terminal window. Run these three commands **one at a time**, waiting after each:

```sh
node scripts/service.mjs install
```

```sh
node scripts/service.mjs start
```

```sh
node scripts/service.mjs status
```

This installs and starts the small background program that connects Claude and Figma. It starts again when you log in to this Mac. It keeps Figma API and comment access disabled.

**You are ready when:** the status shows **state = running** and a **pid** number. You can also open [the local status page](http://localhost:3846/) in your browser. No Figma file may be connected yet; you will do that in Step 9.

If you see **EADDRINUSE**, another bridge may already be running. Ask Arsenio which installation to use before continuing.

## Step 7 Ask Claude to prepare your connection settings

Claude needs two locations from your Mac. Run the following in the same Terminal window:

```sh
command -v node
```

Copy the path it prints. It might look like **/usr/local/bin/node** or **/opt/homebrew/bin/node**; use your actual result.

Then run:

```sh
pwd
```

Copy this result too. It should look like **/Users/yourname/Developer/figma-local-bridge**. Your Mac user name will appear in place of **yourname**.

Open a regular chat in Claude Desktop. Copy the message below, replacing the two **PASTE** lines with your actual results:

> Help me connect Figma Local Bridge to regular Claude Desktop on my Mac. I am not technical. My Node executable is: PASTE THE RESULT OF command -v node HERE. My project folder is: PASTE THE RESULT OF pwd HERE. Generate the complete valid JSON for a new claude_desktop_config.json file. Inside mcpServers, add a server named figma_local. Use my Node executable as command. Set args to my project folder followed by /dist/server.mjs, then --proxy-only. Set env to include FIGMA_BRIDGE_API_DISABLED with the string value "1". Use my actual absolute paths, with no placeholders. Return the JSON in a copyable code box. Keep Figma API and comment access disabled. If I already have other settings, help me add this entry while keeping them.

**You are ready when:** Claude gives you a JSON code box containing **figma_local**, **--proxy-only**, and **FIGMA_BRIDGE_API_DISABLED** set to **"1"**. It should contain your real paths, not **yourname** or **PASTE**.

## Step 8 Save those settings in Claude Desktop

1. Keep Claude's generated JSON available. In Terminal, run the following three lines. They open Claude's local settings file in TextEdit, creating an empty file if necessary. They do not replace existing settings.

```sh
mkdir -p "$HOME/Library/Application Support/Claude"
touch "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
open -a TextEdit "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
```

2. Look at the file in TextEdit. If it is empty or contains only **{}**, paste the complete JSON Claude generated, including the opening and closing braces. Use the **Copy** button on Claude's code box so you copy the JSON itself.
3. If the file already has other settings, keep them. Tell Claude **"This file already has settings. Walk me through adding only the figma_local entry without replacing my existing connections."** Do not paste passwords or access tokens into the chat. If you are unsure how to merge the entry, ask Arsenio to help with this step.
4. In TextEdit, use **Format → Make Plain Text** if that option is available. If the menu says **Make Rich Text**, it is already plain text.
5. Press **Command S** to save. Keep the file name exactly **claude_desktop_config.json**, with no **.txt** added.
6. Return to Claude and press **Command Q** to quit it completely. Open Claude again and start a new regular chat.
7. Click **+ → Connectors** beside the chat box. Look for **figma_local** and enable it for the chat if needed.

**You are ready when:** **figma_local** is listed with its tools. If it is missing, check Claude's local MCP server settings or ask Claude to help check the JSON and the two paths. In current layouts, local server status is under **Settings → Desktop app → Extensions → Manage → Local MCP servers**; older versions use **Settings → Developer**.

## Step 9 Add the bridge plugin to Figma

1. Open **Figma Desktop** and a **Figma Design** file you have permission to edit. Start with a test design for your first session.
2. In Figma, choose **Plugins → Development → Import plugin from manifest…**.
3. In the file picker, press **Command Shift G**, paste the following path, and press Return:

```text
~/Developer/figma-local-bridge/plugin/manifest.json
```

4. Select the file and click **Open**. Figma should add **Local MCP Bridge** to its development plugins.
5. Choose **Plugins → Development → Local MCP Bridge** to run it. Leave its panel open.
6. The panel should say **Connected**. Click **Expand**, then open **Connected files** to see the connection fields.
7. In **Label this file's connection**, enter **Marketing Campaign**, or another clear name for this file.
8. In Figma's **Share** menu, copy the file link. Paste it into **This file's Figma URL** in the bridge panel and click **Save connection details**.

**You are ready when:** the panel says **Connected** and your connection name is saved. Keep the panel open while Claude works. Leave Figma API access disabled; no Figma API token is required.

## Step 10 Check the connection and try one small task

In the regular Claude Desktop chat, paste this message. Replace **Marketing Campaign** if you used a different connection name:

> Use the figma_local tools. First call figma_bridge_status and confirm the connection named "Marketing Campaign" and its current page. List the artboards on that page. Do not change anything yet. Keep Figma API and comment access disabled.

Claude should name the correct file and page, then list the designs it can see. An **artboard** is a frame containing one design, such as an ad or landing page. Confirm that Claude is looking at the correct place.

For your first edit, pick an existing headline in the test design. Tell Claude the artboard name and the exact new text. For example, after replacing the sample names with yours:

> In Marketing Campaign, on the artboard named "Summer Sale", change the headline to "Your summer starts here". Keep the existing fonts, colours, and layout. Check that the new headline fits, then tell me what changed.

When Claude asks to use a tool, review the request and approve it if it matches your task. Check the result directly in Figma before using or sharing the design.

**Setup is complete when:** Claude can identify the correct file/page and you can see the requested small edit in Figma.

## The everyday checklist

You do not need to download the project or run **npm ci** each day.

1. Open the design and the correct page in **Figma Desktop**.
2. Run **Plugins → Development → Local MCP Bridge** and leave its panel open. Saved connection details should return automatically.
3. Open a regular chat in **Claude Desktop** with **figma_local** enabled. Ask it to confirm the connection and page before editing.
4. Give one clear task at a time, then check the result in Figma.

Keep both desktop apps and the plugin panel open until the task is finished. If you duplicate a Figma file, update the saved name and file link in the copy.

## Common problems

- **GitHub shows 404:** ask Arsenio for repository access using your GitHub account name.
- **Terminal says no such file or directory:** check the folder name and its location in Step 3, then repeat the **cd** command from Step 5.
- **Terminal cannot find package.json:** you are in the wrong folder. Repeat the **cd** and **pwd** commands from Step 5.
- **Claude cannot see figma_local:** check the settings file and absolute paths from Steps 7 and 8, then completely quit and reopen Claude.
- **Figma says Connecting instead of Connected:** run the service status command from Step 6. If it is not loaded, run the start command. Close and run the Figma plugin again.
- **Claude sees the wrong file or page:** ask it to stop and confirm the saved connection name and intended page before editing.
- **A change seems stuck:** ask Claude to check the previous operation's status before repeating the edit.

For help, send Arsenio the step number and the exact error. The project folder must stay in its installed location. Use a regular Claude Desktop chat for this local connection; it is unavailable in Claude's website and Cowork.

If a command fails, copy the error into Claude with this message:

> I am setting up Figma Local Bridge on a Mac and I am not technical. I will tell you my step number. Explain this Terminal error and give me one next step at a time. Keep the project's dependency versions and Figma API settings unchanged. Here is the error:

Paste the error below that message. Claude can coach you through a fix; you still run any agreed commands in Terminal.

## Setup references

- [Project README](../README.md)
- [Download Claude Desktop](https://claude.com/download)
- [Download Figma Desktop](https://www.figma.com/downloads/)
- [Download Node.js](https://nodejs.org/en/download)
- [GitHub ZIP download instructions](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives)
- [npm dependency installation](https://docs.npmjs.com/cli/v11/commands/npm-ci/)
- [Claude local server configuration](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
