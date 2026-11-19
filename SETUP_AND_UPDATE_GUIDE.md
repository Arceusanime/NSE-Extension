# NSE Option Chain Scanner & S&R Overlay
## Trader Setup & Auto-Update Guide

This guide explains how to install the extension for the first time and how seamless GitHub-synced updates work.

---

### Part 1: One-Time Client Setup (First Time Only)

#### Step 1: Install Git for Windows
If the client does not already have Git installed:
1. Download Git from [https://git-scm.com/download/win](https://git-scm.com/download/win).
2. Run the installer (keep default options selected, ensuring *"Git from the command line and also from 3rd-party software"* is enabled).

#### Step 2: Clone the Project
Open PowerShell or Command Prompt and run:
```bash
git clone https://github.com/Arceusanime/NSE-Extension.git "C:\Tools\NSE-Extension"
```
*(Or clone into any folder the trader prefers, such as `C:\NSE-Extension`).*

#### Step 3: Load into Google Chrome
1. Open Google Chrome and go to: `chrome://extensions/`
2. In the top-right corner, turn **ON** the **"Developer mode"** toggle switch.
3. In the top-left corner, click **"Load unpacked"**.
4. Select the `NSE-Extension` folder you cloned in Step 2.
5. The extension is now active! Pin it to the Chrome toolbar for quick access.

#### Step 4: Create Desktop Update Shortcut (Optional but Recommended)
1. Open the `NSE-Extension` folder in Windows File Explorer.
2. Right-click `update.bat` -> **Send to** -> **Desktop (create shortcut)**.
3. Rename the desktop shortcut to **"Update NSE Scanner"**.

---

### Part 2: How Automatic Updates Work

The extension includes a built-in background updater connected to the GitHub repository:

1. **Background Polling & Alert Badge**:
   - The extension automatically checks GitHub every hour (and on browser startup).
   - When you push a new release to GitHub, the extension icon in Chrome automatically displays a blue **`NEW`** badge.
   - When the trader opens the extension popup or dashboard, a top notification banner appears:
     > **Update v1.2 available on GitHub!**

2. **Pulling the Update (Trader's 2-Click Action)**:
   - **Click 1**: Double-click the **`Update NSE Scanner`** shortcut on their desktop (runs `update.bat`, which pulls all changed files from GitHub in 2 seconds).
   - **Click 2**: Click the **"Reload"** button inside the extension popup/dashboard banner. The extension immediately reloads with the new code running.

---

### Part 3: Developer / Author Workflow (How You Ship Updates)

Whenever you fix a bug, add a feature, or adapt to an NSE website update:

1. Make your code changes in your local workspace.
2. In `manifest.json`, bump the `"version"` number:
   ```json
   {
     "version": "1.2",
     "updateNotes": "Fixed NSE contract expiry filter and updated S&R calculation."
   }
   ```
3. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Release v1.2"
   git push origin master
   ```
4. That's it! As soon as it reaches GitHub:
   - The trader's browser detects the new version.
   - The trader runs `update.bat` and clicks "Reload".
   - Both sides stay in sync without touching the Chrome Web Store.
