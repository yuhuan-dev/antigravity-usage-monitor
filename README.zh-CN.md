<div align="center">

<img src="assets/logo.svg" alt="Antigravity Usage & Speed Monitor Logo" width="84" />

# Antigravity Usage & Speed Monitor

Google Antigravity 2.0、Antigravity IDE、VS Code（官方扩展）与 Antigravity CLI 的本地用量、速率、上下文与配额监控插件，无外部 npm 依赖。

[![Release](https://img.shields.io/github/v/release/yuhuan-dev/antigravity-usage-monitor?style=flat-square&color=2A5E76&label=release)](https://github.com/yuhuan-dev/antigravity-usage-monitor/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/yuhuan-dev/antigravity-usage-monitor/total?style=flat-square&color=0ea5e9)](https://github.com/yuhuan-dev/antigravity-usage-monitor/releases)
[![Stars](https://img.shields.io/github/stars/yuhuan-dev/antigravity-usage-monitor?style=flat-square&color=f59e0b)](https://github.com/yuhuan-dev/antigravity-usage-monitor/stargazers)
[![License](https://img.shields.io/github/license/yuhuan-dev/antigravity-usage-monitor?style=flat-square&color=3b82f6)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20npm%20%E4%BE%9D%E8%B5%96-10b981?style=flat-square)](#本地开发)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-6366f1?style=flat-square)](#客户端支持)

[English](README.md) · 简体中文

[功能](#功能) · [截图](#截图) · [客户端支持](#客户端支持) · [安装](#安装) · [使用方式](#使用方式) · [开发](#本地开发)

<br />

<img src="assets/preview.png" alt="Antigravity Usage Monitor 界面预览" width="100%" />

<br />

[下载最新版本 (Releases)](https://github.com/yuhuan-dev/antigravity-usage-monitor/releases/latest) · [下载压缩包 (`usage-monitor.zip`)](https://github.com/yuhuan-dev/antigravity-usage-monitor/releases/latest/download/usage-monitor.zip)

</div>

---

## 功能

- **实时指标与版面编排**：统计单步输出速度（`tok/s`）、首字延迟（`TTFT`）、会话平均速度、单步/累计费用、缓存命中率、最紧缺配额与已用 Token；可在设置中从 9 项指标中自由勾选并拖拽排序（默认展示 4 项），并调整实时监控各模块顺序。
- **10 类上下文窗口构成**：展示最近一次请求的上下文占比，按占用列出模型回复、工具结果、用户消息、子代理通知、压缩摘要、系统提示词、系统工具、MCP 工具、Skill 与用户规则，支持在主代理与任意子代理之间切换查看。
- **配额池监控、预占估算及速率参考**：追踪 `Gemini`、`Gemini 4 Argon`、`Gemini 4 Carbon` 及 `Claude & GPT` 配额池的 5 小时及每周用量、重置倒计时、周期累计消耗及 Ultra `5x / 20x` 倍率标识；内置租约预占斜纹指示段及按账号隔离的模型消耗速率/等效满池费用悬浮卡（`?`），上游暂未返回新数据时保留缓存状态及提示。
- **账号登录及切换（Windows）**：在「偏好设置 → 账号」点击「使用 Google 登录」，通过浏览器授权后自动保存账号并查询额度；也支持导入已有刷新令牌或 OAuth JSON。「切换并重启」关闭并重开 App 和共享登录的新版 IDE，以载入选定凭证，切换前请保存工作。
- **主/子代理、Swarm 蜂群及 SSH 多远端隔离**：按时间归并展示主代理、子代理及原生 Swarm Worker 调用步骤（也可按单一代理过滤），支持轮次分组导轨及运行中任务原地展开，并对多个 SSH Remote 远端窗口按端点独立隔离轨迹缓存及配额状态。
- **调用明细、耗时拆解及异常筛选**：包含「按步查看」及「按模型汇总」（含多模型 LOESS 吞吐/TTFT 拟合曲线）；支持表头点击排序、首字延迟/总耗时分阶段悬停拆解、压缩行强调色高亮及悬停诊断、可选实时搜索及 9 类异常/慢首字/低缓存快捷诊断筛选条；支持定制 2–14 列及 `context:in:cache` 等自定义 Token 语法。
- **历史用量、项目工作区归因及日历热力图**：按今天、1 天、7 天、14 天、30 天、全部或自定义时间窗统计总 Token、缓存节省金额、输出/思考拆分、平滑小时/日趋势折线（跨度 `>90` 天自动切换为每日日历热力图）、**模型 / 项目工作区 / 会话**三合一排行、客户端来源（App / IDE / CLI）及月度堆叠柱状图，均配备跟手悬浮明细卡。
- **原生多表 `.xlsx` 报表导出及配置备份**：支持将用量统计及调用明细直接导出为多工作表双语 Excel（`.xlsx`）工作簿或复制 Markdown 汇总报告（落盘至 `~/Downloads` 并弹出「打开位置」定位提示），同时支持便携 JSON 偏好配置备份导入导出。
- **跨客户端会话无损迁移**：在「偏好设置 → 其他」提供 `CLI ↔ 桌面端 / 新版 IDE` 及 `旧版 IDE (.db)` 按需会话迁移及克隆副本工具，自动重写独立 UUID 防止跨端镜像互删及重复计费。
- **多端胶囊及 CLI `statusLine` 多模式**：支持 Antigravity 2.0 顶栏/输入框胶囊（含环形额度指示及主代理上下文锁定）及右侧辅助栏、Antigravity IDE 顶栏/输入框胶囊、Antigravity CLI（`agy`）单行 24-bit ANSI `statusLine`（支持 `--style pill|bar|compact`、`--preset compact|balanced|full` 及 `--json` 快照输出）以及独立 Web 页面。
- **VS Code 官方扩展与 Remote-SSH 适配**：自动补齐 `~/.vscode/argv.json`，默认以独立设置挂载在聊天输入框（支持切换为顶部栏，不提供仅侧边栏）；支持本地与 Remote-SSH 远端扩展及远端 `agy` CLI 插件的自动识别、端点隔离与实时会话跟随，未安装对应插件的窗口自动静默跳过。
- **不修改 `app.asar` 及 Desktop 2.33.0+ 自动补齐**：桌面端和 IDE 的胶囊挂载及上下文改写均通过本地 CDP 内存注入完成；自动补齐 Desktop `2.33.0+` 用户快捷方式/启动项（支持面板内一键脱离作业树带参重拉）及 `~/.antigravity-ide/argv.json`，绝不触碰宿主安装包及 `app.asar`。
- **按模型设置上下文窗口（主代理 + 子代理/Swarm）**：支持按模型系列指定上下文上限或跟随宿主默认，提供独立的主代理开关（CDP 请求钩子）及子代理 / Swarm Worker 同步开关（本机回环 CloudCode 透明反代），CLI 端通过 `AGY_CLI_AUTO_COMPACT_OVERRIDE` 控制。
- **外观定制、离线读取及云端同步**：提供简体中文 / English / 跟随宿主语言、无边框 Modern UI、`sm / md / lg / xl` 字号、6 种主题强调色；离线直读 CLI SQLite + WAL、`annotations/*.pbtxt`、`transcript.jsonl` 及 `.deep_stats_cache.json`；内置 GitHub [`pricing-catalog.json`](pricing-catalog.json) 同步及面板内更新（手动 / 自动 / 关闭）。

---

## 截图

### IDE 与 CLI

<table>
  <tr>
    <td align="center">
      <img src="assets/ide-preview.png" alt="Antigravity IDE 顶栏胶囊与悬浮速览" width="100%" />
      <br />
      <b>Antigravity IDE</b>
      <br />
      <sub>顶栏悬浮胶囊与速览浮窗，显示当前步骤费用、上下文占用与配额状态</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="assets/cli-preview.png" alt="Antigravity CLI 原生底部 statusLine 胶囊" width="100%" />
      <br />
      <b>Antigravity CLI (<code>agy</code>)</b>
      <br />
      <sub>终端底栏单行 24-bit ANSI <code>statusLine</code>，支持彩色胶囊/进度条/紧凑三档样式，实时显示活跃数、输出速率、首字延迟、单步费用及配额/上下文占比</sub>
    </td>
  </tr>
</table>

### 面板标签页

<table>
  <tr>
    <td align="center" width="33.3%">
      <img src="assets/context.png" alt="实时监控及上下文窗口" />
      <br />
      <b>实时监控</b>
      <br />
      <sub>输出速率、首字延迟、10 类上下文构成、带预占估算的配额池及蜂群/子代理运行任务</sub>
    </td>
    <td align="center" width="33.3%">
      <img src="assets/analytics.png" alt="历史用量及趋势统计" />
      <br />
      <b>用量统计</b>
      <br />
      <sub>Token 汇总、缓存命中率、平滑趋势曲线及模型/项目/会话三合一排行</sub>
    </td>
    <td align="center" width="33.3%">
      <img src="assets/subagents.png" alt="主代理、蜂群及子代理调用明细" />
      <br />
      <b>调用明细</b>
      <br />
      <sub>支持排序的主代理、蜂群及子代理调用记录，含轮次导轨、压缩行高亮及费用拆解</sub>
    </td>
  </tr>
</table>

---

## 客户端支持

| 客户端 / 运行环境 | 状态胶囊 / 底栏 | 监控面板 | 离线 SQLite 及日志读取 | 按模型上下文限制 | 修改 `app.asar` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Antigravity 2.0 桌面端** | 顶栏 / 输入框停靠 | 悬浮窗 + 右侧辅助栏 | 支持 | CDP 钩子 + 本机 CloudCode 反代 | 否 |
| **Antigravity IDE** | 顶栏 / 输入框停靠 | 点击胶囊展开面板 | 支持 | CDP 钩子 + 本机 CloudCode 反代 | 否 |
| **VS Code（官方扩展 / Remote-SSH）** | 输入框（默认）/ 顶部栏 | 点击胶囊展开面板 | 支持 | 按宿主 / 端点同步 | 否 |
| **Antigravity CLI (`agy`)** | 终端底栏 `statusLine` | 独立 Web (`--port`) | 支持（`node:sqlite` + `.pbtxt`） | `AGY_CLI_AUTO_COMPACT_OVERRIDE` | 否 |
| **无头服务器 / SSH 远程** | 按端点胶囊 / ANSI `statusLine` | SSH 悬浮窗 / `--token` Web | 支持 | 按端点钩子 / 环境变量 | 否 |

> [!NOTE]
> 在 **Antigravity Desktop 2.33.0+** 和 **Antigravity IDE** 中启用插件时，后台会通过零工具开销的 MCP 保活入口（不消耗上下文 Token）自动补齐桌面端用户快捷方式启动参数或向 `~/.antigravity-ide/argv.json` 写入 `"remote-debugging-port": "0"`（保留原有注释及配置项）。桌面端可直接点击面板顶部的「一键带参重拉」生效，IDE 首次启用后重启一次即可挂载顶栏胶囊。

---

## 安装

插件目录名需保持为 `usage-monitor`，**无需运行 `npm install`**。

### 方式一：下载 Release 压缩包

下载 [`usage-monitor.zip`](https://github.com/yuhuan-dev/antigravity-usage-monitor/releases/latest/download/usage-monitor.zip)，解压到 `~/.gemini/config/plugins/` 下并保持文件夹名为 `usage-monitor`。

<details>
<summary>Windows PowerShell 下载及解压命令</summary>

```powershell
$pluginsDir = "$env:USERPROFILE\.gemini\config\plugins"
New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
Invoke-WebRequest -Uri "https://github.com/yuhuan-dev/antigravity-usage-monitor/releases/latest/download/usage-monitor.zip" -OutFile "$env:TEMP\usage-monitor.zip"
Expand-Archive -Path "$env:TEMP\usage-monitor.zip" -DestinationPath $pluginsDir -Force
```

</details>

### 方式二：Git 克隆

```powershell
# Windows PowerShell
git clone --filter=blob:none --single-branch https://github.com/yuhuan-dev/antigravity-usage-monitor.git "$env:USERPROFILE\.gemini\config\plugins\usage-monitor"
```

```bash
# macOS / Linux
git clone --filter=blob:none --single-branch https://github.com/yuhuan-dev/antigravity-usage-monitor.git ~/.gemini/config/plugins/usage-monitor
```

也可以直接在 Antigravity 对话中执行：

```text
把 https://github.com/yuhuan-dev/antigravity-usage-monitor 用 --filter=blob:none --single-branch 克隆到 ~/.gemini/config/plugins/usage-monitor 并启用插件
```

---

## 使用方式

1. 打开左侧边栏 **Customizations → Installed**，找到 `usage-monitor` 并开启。
2. **Antigravity 2.0 桌面端**：
   - 主窗口右上角挂载悬浮胶囊（**悬停**查看速览，**左键**打开四标签面板，**右键**强制刷新），同时可在右侧辅助栏打开「用量监控」。
3. **Antigravity IDE**：
   - 首次启用后**重启一次 Antigravity IDE**，保持挂载方式为「双栖挂载」，点击顶栏胶囊即可打开面板。
4. **VS Code（官方扩展 / Remote-SSH）**：
   - 首次启用后**重启一次 VS Code**（自动写入 `~/.vscode/argv.json`）；默认挂载在 Antigravity 聊天输入框，可在设置中切换为「顶部栏」。若未安装 VS Code 扩展、仅安装本机或远端（需免密 SSH）的 `agy` CLI 插件，将自动显示于顶部栏。
5. **Antigravity CLI (`agy`) 底部胶囊**：
   - 检测到 `~/.gemini/antigravity-cli` 时自动写入原生 `statusLine` 配置（保留已有自定义 `statusLine.command`），在终端底栏单行显示当前活跃状态、输出速率、首字延迟与上下文占比（如 `● 1 运行中   38.1 t/s | 0.85s | ◎ 17%`）。
   - 可在 `agy` 中通过 `/statusline` 或在面板 **偏好设置 → 界面编排 → 挂载胶囊** 开关及调整显示顺序。
6. **独立 Web 服务（纯终端 / 远程服务器）**：

```bash
# 1. 在远程服务器上启动（默认监听 127.0.0.1:8787）
node ~/.gemini/config/plugins/usage-monitor/sidecars/panel/standalone.mjs --port 8787

# 2. 本地端口转发后，浏览器访问 http://localhost:8787
ssh -L 8787:127.0.0.1:8787 user@your-server
```

<details>
<summary>独立 Web 命令行参数、随 agy 自动启动与非回环令牌校验</summary>

- **随 `agy` 自动启动**：设置环境变量 `USAGE_MONITOR_STANDALONE_PORT=8787`，或在 `~/.gemini/antigravity-cli/sidecar_data/usage-monitor/panel/data/settings.json` 中添加 `"standalonePort": 8787`，插件随 MCP 进程启动时会自动拉起 Web 服务。
- **非回环访问校验**：绑定 `0.0.0.0` 或局域网 IP 时必须提供 `--token <密钥>`（或环境变量 `USAGE_MONITOR_STANDALONE_TOKEN`），未设置令牌会拒绝启动。
- **常用参数**：支持 `--data-dir`、`--app-data-dir`、`--gemini-dir`、`--ls-addr` 与 `--csrf-token`。
- **离线数据读取**：在 `agy` 未运行的状态下，后台直接读取 `~/.gemini/antigravity-cli` 下的 `conversation_summaries.db`、`conversations/*.db`、`annotations/*.pbtxt` 与 `transcript.jsonl`，待 `agy` 启动后自动切换为实时 RPC 数据。

</details>

---

## 配置说明与计算口径

<details>
<summary>界面与字段配置（挂载方式、胶囊槽位、Token 组合格式、模型命名与上下文限制）</summary>

- **挂载模式与浮窗宽度**：支持「双栖挂载（顶部栏 + 侧边栏）」、「输入框挂载」与「仅侧边栏」；悬浮窗默认使用「自动适配」（宽表格下在窗口范围内自动加宽），也可设置为 `440~1080 px` 固定宽度。
- **胶囊槽位**：支持在 1 至 5 个指标间增删与排序（默认显示输出速度、首字延迟与上下文占用），并可单独开关运行中会话指示器。
- **调用明细与 Token 组合**：在「界面编排 → 调用明细字段」可分别开关主/子代理标识、对话轮次导轨（默认关闭）与输出速度多色分级（默认关闭）；Token 列默认显示 `上下文 / 思考 / 正文`，可切换至 `输入 / 输出 / 缓存` 预设（悬停显示美元分项），或使用 `context:new:cache`、`in:out:cache` 等自定义格式字符串。
- **模型命名格式**：支持精简代号（如 `argon-4-high`）、原始模型 ID 与去前缀原始 ID（去掉 `gemini-` / `claude-` / `gpt-` 前缀并保留 `·压缩` 标记）三档；Orchestrator 系列支持单独设置。
- **按模型设置上下文窗口**：在「其他 → 模型上下文设置」中为同一模型的各推理档位设置统一上限或「跟随宿主设置」。App / IDE 会在启动后作用于后续请求；CLI 通过 `AGY_CLI_AUTO_COMPACT_OVERRIDE` 控制。

</details>

<details>
<summary>模型识别、压缩步骤推断与费用折算说明</summary>

- **模型识别规则**：直接读取当前步骤的原始用量字段与对应生成记录，已记录的模型不会被后续推断覆盖。当上下文压缩步骤缺少模型字段时，按同一会话内「先向前、后向后，优先同提供方、再放宽匹配」的顺序推断用于展示与费用估算；无可推断来源时标注为「模型未知·压缩」。
- **费用计算口径**：模型或价格项未匹配时，单步费用记为「待定」，Token 数量仍正常统计；汇总金额仅累加已确认单价的步骤。美元金额基于 [`pricing-catalog.json`](pricing-catalog.json) 中的公开 API 单价估算，仅供本地对比参考，不代表订阅配额扣减比例。
- **升级校验与均速口径**：插件升级后会按原始轨迹重新校验旧缓存，同时保留既有 Token 与有效计时；压缩步骤在调用明细中展示完整请求 TPS，但不会计入会话平均生成速度与平均首字延迟。

</details>

<details>
<summary>更新方式与本地数据目录</summary>

- **面板内检查更新**：检测到 GitHub 新版本时，胶囊旁与面板顶栏会显示更新标记，点击后拉取更新并自动重载；可在 **偏好设置 → 其他** 选择「手动提示 / 自动更新 / 关闭」，或手动同步价格表。
- **Git 手动更新**：
  - Windows：`git -C "$env:USERPROFILE\.gemini\config\plugins\usage-monitor" pull --ff-only`
  - macOS / Linux：`git -C ~/.gemini/config/plugins/usage-monitor pull --ff-only`
  - 更新后在 **Customizations → Installed** 重新开关一次插件生效。
- **数据目录**：缓存与设置保存在 `~/.gemini/antigravity/sidecar_data/usage-monitor/`（独立模式未指定 `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 时存放在 `sidecars/panel/.data/`），升级插件不会清除历史记录。

</details>

---

## 本地开发

前后端代码采用纯 Node.js ESM 及自研轻量响应式组件和增量 DOM 修补内核（`defineComponent` + `domPatch`，宿主悬浮窗采用 Shadow DOM 样式隔离）编写，**无外部 npm 依赖**（建议使用 Node.js 22.5+ 以使用内置 `node:sqlite`）。

```bash
cd sidecars/panel

# 修改 src/ 下源码后重新构建 app.js 与 styles.css
npm run build

# 运行单元测试与回归测试
npm test
```

## 参与贡献与开源协议

欢迎提交 Issue 或 Pull Request。若修改了 `sidecars/panel/src/` 下的前端源码，请先执行 `npm run build` 重新生成产物，并确保 `npm test` 全部通过。

本项目基于 [GNU General Public License v3.0](LICENSE) 开源。

## Star 趋势

<a href="https://www.star-history.com/#yuhuan-dev/antigravity-usage-monitor&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=yuhuan-dev/antigravity-usage-monitor&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=yuhuan-dev/antigravity-usage-monitor&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=yuhuan-dev/antigravity-usage-monitor&type=Date" />
  </picture>
</a>
