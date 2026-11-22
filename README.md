<div align="center">

<img src="assets/logo.svg" alt="Antigravity Usage & Speed Monitor Logo" width="84" />

# Antigravity Usage & Speed Monitor

Local usage, speed, context, and quota monitor for Google Antigravity 2.0, Antigravity IDE, and Antigravity CLI, with no external npm dependencies.

[![Release](https://img.shields.io/github/v/release/yuhuan-dev/antigravity-usage-monitor?style=flat-square&color=2A5E76&label=release)](https://github.com/yuhuan-dev/antigravity-usage-monitor/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/yuhuan-dev/antigravity-usage-monitor/total?style=flat-square&color=0ea5e9)](https://github.com/yuhuan-dev/antigravity-usage-monitor/releases)
[![Stars](https://img.shields.io/github/stars/yuhuan-dev/antigravity-usage-monitor?style=flat-square&color=f59e0b)](https://github.com/yuhuan-dev/antigravity-usage-monitor/stargazers)
[![License](https://img.shields.io/github/license/yuhuan-dev/antigravity-usage-monitor?style=flat-square&color=3b82f6)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20npm%20packages-10b981?style=flat-square)](#local-development)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-6366f1?style=flat-square)](#client-support)

English · [简体中文](README.zh-CN.md)

[Features](#features) · [Screenshots](#screenshots) · [Client Support](#client-support) · [Installation](#installation) · [Usage](#usage) · [Development](#local-development)

<br />

<img src="assets/preview.png" alt="Antigravity Usage Monitor Preview" width="100%" />

<br />

[Latest Release](https://github.com/yuhuan-dev/antigravity-usage-monitor/releases/latest) · [Download ZIP (`usage-monitor.zip`)](https://github.com/yuhuan-dev/antigravity-usage-monitor/releases/latest/download/usage-monitor.zip)

</div>

---

## Features

- **Live Metrics & Customizable Layout**: Tracks output speed (`tok/s`), time-to-first-token (`TTFT`), session average speed, step/session USD cost, cache hit rate, tightest remaining quota, and session tokens. You can choose and reorder the overview metric cards (4 shown by default out of 9 options) and section blocks.
- **10-Category Context Breakdown**: Shows the token breakdown of the latest request across assistant replies, tool results, user messages, subagent notifications, checkpoints, system prompts, system tools, MCP tools, skills, and user rules, with a switcher between the main agent and spawned subagents.
- **Quota Pool Tracking**: Reads 5-hour and weekly quotas, reset timers, and cycle consumption across `Gemini`, `Gemini 4 Argon`, `Gemini 4 Carbon`, and `Claude & GPT` pools, preserving cached pool status with a stale badge when upstream quota data is temporarily unavailable.
- **Main Agent, Subagents & Multi-Session Views**: Merges main agent and subagent steps in chronological order (or filters by individual agent), renders optional turn rails, expands running subagent tasks inline, and provides a recent-conversation selector in the header.
- **Call Details & Custom Token Formats**: Includes **By Step** and **By Model** tabs (with multi-model throughput charts). Supports 2–14 configurable columns, optional speed color grading, preset `Ctx / Think / Reply` and `In / Out / Cache` columns, and custom token combination strings such as `context:new:cache` or `in:out:cache`.
- **Historical Usage & Breakdowns**: Summarizes tokens, uncached input vs. cache-read savings, thinking/output split, hourly/daily trend curves, model rankings, client attribution (`Desktop App` / `IDE` / `CLI`), and monthly bar charts across `Today`, `1d`, `7d`, `14d`, `30d`, `All`, or custom date/time ranges.
- **Multi-Client Capsules & Hover Popover**: Integrates as a titlebar or composer capsule and auxiliary sidebar in Antigravity 2.0, a titlebar/composer capsule in Antigravity IDE, a single-line 24-bit ANSI `statusLine` in Antigravity CLI (`agy`), and a standalone local web UI. Supports 1–5 customizable capsule slots, configurable hover cards, and `Auto Fit` or fixed (`440–1080 px`) popover widths.
- **No `app.asar` Modification**: Titlebar/composer injection and context request hooks run in memory over local CDP (`DevToolsActivePort`). On Antigravity IDE, the only host file updated is adding `"remote-debugging-port": "0"` to `~/.antigravity-ide/argv.json`; installation binaries and `app.asar` are never altered.
- **Per-Model Context Windows**: Sets context window limits per model series (across thinking levels) or follows host defaults under Settings. Desktop/IDE applies rules at runtime on outbound requests; CLI applies `AGY_CLI_AUTO_COMPACT_OVERRIDE`.
- **Appearance, Offline Storage & Cloud Updates**: Supports `zh-CN` / `en-US` / host language, `sm / md / lg / xl` font scaling, 6 theme accents plus host matching, offline reading from CLI SQLite + WAL, `annotations/*.pbtxt`, `transcript.jsonl`, and `.deep_stats_cache.json`, GitHub [`pricing-catalog.json`](pricing-catalog.json) sync, in-panel release updates (`manual` / `auto` / `off`), and cache rebuild/settings reset tools.

---

## Screenshots

### IDE & CLI

<table>
  <tr>
    <td align="center">
      <img src="assets/ide-preview.png" alt="Antigravity IDE Titlebar Capsule and Hover Overview" width="100%" />
      <br />
      <b>Antigravity IDE</b>
      <br />
      <sub>Titlebar capsule and hover popover showing step cost, context usage, and pool quotas</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="assets/cli-preview.png" alt="Antigravity CLI Native statusLine Capsule" width="100%" />
      <br />
      <b>Antigravity CLI (<code>agy</code>)</b>
      <br />
      <sub>Single-line transparent 24-bit ANSI bottom <code>statusLine</code> with active count, TPS, TTFT, and context percentage</sub>
    </td>
  </tr>
</table>

### Panel Tabs

<table>
  <tr>
    <td align="center" width="33.3%">
      <img src="assets/context.png" alt="Live Overview and Quotas" />
      <br />
      <b>Live Overview</b>
      <br />
      <sub>TPS, TTFT, 10-category context bar, quota pools, and active tasks</sub>
    </td>
    <td align="center" width="33.3%">
      <img src="assets/analytics.png" alt="Usage Statistics" />
      <br />
      <b>Usage Statistics</b>
      <br />
      <sub>Token totals, cache hit rate, trend chart, and model breakdown</sub>
    </td>
    <td align="center" width="33.3%">
      <img src="assets/subagents.png" alt="Call Details and Subagents" />
      <br />
      <b>Call Details</b>
      <br />
      <sub>Step-by-step agent badge, model, speed, TTFT, tokens, and cost</sub>
    </td>
  </tr>
</table>

---

## Client Support

| Client | Status Capsule / Bar | Panel UI | Offline SQLite &amp; Logs | Per-Model Context Limit | Modifies `app.asar` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Antigravity 2.0 (Desktop)** | Titlebar / Composer | Popover + Right Sidebar | Yes | Window Request Hook | No |
| **Antigravity IDE** | Titlebar / Composer | Capsule Popover | Yes | Window Request Hook | No |
| **Antigravity CLI (`agy`)** | Native ANSI `statusLine` | Standalone Web (`--port`) | Yes (`node:sqlite` + `.pbtxt`) | `AGY_CLI_AUTO_COMPACT_OVERRIDE` | No |
| **Remote / Headless Linux** | Native ANSI `statusLine` | SSH Tunnel / `--token` Web | Yes | `AGY_CLI_AUTO_COMPACT_OVERRIDE` | No |

> [!NOTE]
> On **Antigravity IDE**, enabling the plugin automatically adds `"remote-debugging-port": "0"` to `~/.antigravity-ide/argv.json` (preserving comments and existing keys) via a zero-tool MCP keep-alive entry (`0` context tokens). Restart Antigravity IDE once after the first activation so the titlebar capsule can attach.

---

## Installation

Keep the folder name as `usage-monitor`. **No `npm install` is needed.**

### Option 1: Release ZIP

Download [`usage-monitor.zip`](https://github.com/yuhuan-dev/antigravity-usage-monitor/releases/latest/download/usage-monitor.zip) and extract it into `~/.gemini/config/plugins/` so the directory path is `~/.gemini/config/plugins/usage-monitor`.

<details>
<summary>Windows PowerShell command for ZIP installation</summary>

```powershell
$pluginsDir = "$env:USERPROFILE\.gemini\config\plugins"
New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
Invoke-WebRequest -Uri "https://github.com/yuhuan-dev/antigravity-usage-monitor/releases/latest/download/usage-monitor.zip" -OutFile "$env:TEMP\usage-monitor.zip"
Expand-Archive -Path "$env:TEMP\usage-monitor.zip" -DestinationPath $pluginsDir -Force
```

</details>

### Option 2: Git Clone

```powershell
# Windows (PowerShell)
git clone --filter=blob:none --single-branch https://github.com/yuhuan-dev/antigravity-usage-monitor.git "$env:USERPROFILE\.gemini\config\plugins\usage-monitor"
```

```bash
# macOS / Linux
git clone --filter=blob:none --single-branch https://github.com/yuhuan-dev/antigravity-usage-monitor.git ~/.gemini/config/plugins/usage-monitor
```

Or ask Antigravity directly:

```text
Clone https://github.com/yuhuan-dev/antigravity-usage-monitor with --filter=blob:none --single-branch to ~/.gemini/config/plugins/usage-monitor and enable the plugin
```

---

## Usage

1. Open **Customizations → Installed** in the left sidebar and enable `usage-monitor`.
2. **Antigravity 2.0 (Desktop)**:
   - Mounts a capsule in the top-right titlebar (**hover** for summary, **click** for the 4-tab popover, **right-click** to refresh), alongside the right auxiliary sidebar pane.
3. **Antigravity IDE**:
   - **Restart Antigravity IDE once** after enabling for the first time. Keep **Mount Mode** on **Dual-mount** and click the top-bar capsule to open the panel.
4. **Antigravity CLI (`agy`)**:
   - When `~/.gemini/antigravity-cli` exists, `statusLine` in `settings.json` is configured automatically (existing third-party `statusLine.command` entries are left untouched) to render a single-line ANSI bar (`● 1 active   38.1 t/s | 0.85s | ◎ 17%`).
   - Toggle via `/statusline` in `agy` or **Preferences → Structure → Mount & Capsule Bar**.
5. **Standalone Web Server (Headless / Remote)**:

```bash
# 1. Start on the host (listens on 127.0.0.1:8787 by default)
node ~/.gemini/config/plugins/usage-monitor/sidecars/panel/standalone.mjs --port 8787

# 2. Forward the port locally and open http://localhost:8787
ssh -L 8787:127.0.0.1:8787 user@your-server
```

<details>
<summary>Standalone CLI flags, background auto-start, and non-loopback token auth</summary>

- **Auto-start with `agy`**: Set `USAGE_MONITOR_STANDALONE_PORT=8787` or `"standalonePort": 8787` in `~/.gemini/antigravity-cli/sidecar_data/usage-monitor/panel/data/settings.json` to start the web UI together with the MCP sidecar supervisor.
- **Non-loopback auth**: Binding to `0.0.0.0` or a LAN address requires `--token <secret>` (or `USAGE_MONITOR_STANDALONE_TOKEN`); starting on a non-loopback address without a token is rejected.
- **Overrides**: Supports `--data-dir`, `--app-data-dir`, `--gemini-dir`, `--ls-addr`, and `--csrf-token`.
- **Offline fallback**: When `agy` is not running, the backend reads `~/.gemini/antigravity-cli` (`conversation_summaries.db`, `conversations/*.db`, `annotations/*.pbtxt`, and `transcript.jsonl`) and switches to live RPC once `agy` starts.

</details>

---

## Configuration & Calculation Notes

<details>
<summary>UI options: mount mode, capsule slots, token formats, model IDs, and context limits</summary>

- **Mount Mode & Width**: Switch between **Dual-mount (Top Bar + Sidebar)**, **Composer**, and **Sidebar only**. Popover width defaults to **Auto Fit** (expands within window bounds for wide tables) or a fixed width (`440–1080 px`).
- **Capsule Slots**: Choose 1–5 metric slots and reorder them (default: Output Speed, TTFT, Context Usage), plus an optional toggle for the active-session indicator.
- **Call Details Table & Token Format**: Toggle agent badges, turn rail (off by default), and speed color grading (off by default). Choose `Ctx / Think / Reply`, `In / Out / Cache` (with per-item USD tooltips), or custom format strings like `context:new:cache` or `in:out:cache`.
- **Model Name Format**: Choose **Compact short alias** (`argon-4-high`), **Full raw ID**, or **Trimmed raw ID** (strips `gemini-` / `claude-` / `gpt-` prefixes while keeping `·compact` suffixes intact). Orchestrator series IDs have a separate setting.
- **Per-Model Context Limits**: Configure limits per model across thinking levels or follow host defaults under **Preferences → Other → Model Context Settings**. App/IDE applies saved rules at startup; CLI sets `AGY_CLI_AUTO_COMPACT_OVERRIDE`.

</details>

<details>
<summary>Model identification, compaction inference, and cost estimation rules</summary>

- **Model Resolution**: Read from each step's raw usage payload or matching generator metadata; explicit models are never overwritten. When an automatic compaction step omits the model field, it is inferred from adjacent steps in the same conversation (checking prior steps first, then following steps, preferring the same provider) for display and estimation, or shown as unknown compaction if none exist.
- **Cost Calculation**: If a model or price entry cannot be resolved, step cost is shown as pending while tokens still count toward totals; session totals sum all resolved steps. USD numbers are estimated from public per-million-token API pricing in [`pricing-catalog.json`](pricing-catalog.json) for reference only and do **not** reflect subscription quota consumption.
- **Cache & Speed Averages**: Upgrading re-checks cached entries against raw trajectory data while preserving token counts and valid timings. Compaction steps display request TPS in step tables but are excluded from session speed and TTFT averages.

</details>

<details>
<summary>Updating and data directory</summary>

- **In-Panel Update**: When a new GitHub release is available, a version badge appears next to the capsule and in the panel header. Update mode (`Manual` / `Auto` / `Off`) and price catalog sync can be configured under **Preferences → Other**.
- **Manual Git Update**:
  - Windows: `git -C "$env:USERPROFILE\.gemini\config\plugins\usage-monitor" pull --ff-only`
  - macOS / Linux: `git -C ~/.gemini/config/plugins/usage-monitor pull --ff-only`
  - Toggle the plugin off and back on in **Customizations → Installed**.
- **Data Persistence**: Settings and parsed caches live in `~/.gemini/antigravity/sidecar_data/usage-monitor/` (or `sidecars/panel/.data/` in standalone mode), so updates keep existing history intact.
- **Deleted Local Sessions**: When a full scan of the current account finds that a session has no local copies or host summary, the plugin hides it from the conversation selector. For sessions previously seen on disk, the plugin clears cached step details if a second full scan at least 60 seconds later still finds the session missing. The **Usage** tab keeps per-request metrics such as account, model, timestamp, and token counts. A one-way hash of the session ID prevents double-counting older statistics or restored copies.

</details>

---

## Local Development

All backend and frontend modules use Node.js ESM and native Web Components with **no external npm dependencies** (Node.js 22.5+ is recommended for built-in `node:sqlite`).

```bash
cd sidecars/panel

# Rebuild app.js and styles.css after modifying src/
npm run build

# Run unit and integration tests
npm test
```

## Contributing & License

Issues and pull requests are welcome. If you modify files under `sidecars/panel/src/`, please rebuild via `npm run build` and make sure `npm test` passes.

Licensed under the [GNU General Public License v3.0](LICENSE).

## Star History

<a href="https://www.star-history.com/#yuhuan-dev/antigravity-usage-monitor&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=yuhuan-dev/antigravity-usage-monitor&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=yuhuan-dev/antigravity-usage-monitor&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=yuhuan-dev/antigravity-usage-monitor&type=Date" />
  </picture>
</a>
