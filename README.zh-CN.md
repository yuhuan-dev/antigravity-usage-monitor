<div align="center">

<img src="assets/logo.svg" alt="Antigravity Usage & Speed Monitor Logo" width="84" />

# Antigravity Usage & Speed Monitor

Google Antigravity 2.0、Antigravity IDE 与 Antigravity CLI 的本地用量、速率、上下文与配额监控插件，无外部 npm 依赖。

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
- **配额池监控与过期提示**：追踪 `Gemini`、`Gemini 4 Argon`、`Gemini 4 Carbon` 与 `Claude & GPT` 配额池的 5 小时及每周余量、重置倒计时与周期累计用量；上游接口暂未返回新数据时保留缓存余量并显示陈旧提示。
- **主/子代理联动与多会话管理**：按时间归并展示主代理与各子代理调用步骤（也可按单一代理过滤），支持可选轮次分组导轨与运行中子代理卡片原地展开，并在顶栏切换最近会话。
- **调用明细与自定义 Token 格式**：包含「按步查看」与「按模型汇总」（含多模型拟合图）；支持增删与排序 2–14 列、独立开关速度分段配色，除预设的 `上下文 / 思考 / 正文` 和 `输入 / 输出 / 缓存` 外，可通过 `context:new:cache`、`in:out:cache` 等语法自定义 Token 组合展示。
- **历史用量与来源统计**：按今天、1 天、7 天、14 天、30 天、全部或自定义起止日期时间统计总 Token、新输入与缓存读取节省金额、输出/思考拆分、按小时/按天趋势折线图、模型排行、客户端来源（App / IDE / CLI）与月度柱状图。
- **多端胶囊与悬浮速览**：支持 Antigravity 2.0 顶栏/输入框停靠胶囊与右侧辅助栏、Antigravity IDE 顶栏/输入框胶囊、Antigravity CLI（`agy`）单行 24-bit ANSI `statusLine` 与独立 Web 页面；支持自定义 1–5 个胶囊指标槽位、悬停速览卡片内容以及自动适宽（或 `440~1080 px` 固定宽度）。
- **不修改 `app.asar`**：桌面端与 IDE 的胶囊挂载及上下文请求改写均在运行时通过本地 CDP 内存注入完成（IDE 首次启用时仅向 `~/.antigravity-ide/argv.json` 写入 `"remote-debugging-port": "0"`，保留注释与原有配置），不触碰宿主安装包与 `app.asar`。
- **按模型设置上下文窗口**：支持按模型系列（跨思考档位）统一指定上下文上限或跟随宿主默认；桌面端与 IDE 在请求层生效，CLI 通过环境变量 `AGY_CLI_AUTO_COMPACT_OVERRIDE` 控制。
- **外观定制、离线读取与云端同步**：提供简体中文 / English / 自动跟随宿主语言、`sm / md / lg / xl` 字号、6 种主题强调色（含跟随宿主主题）；离线支持直读 CLI SQLite + WAL、`annotations/*.pbtxt`、`transcript.jsonl` 与 `.deep_stats_cache.json`；内置 GitHub [`pricing-catalog.json`](pricing-catalog.json) 同步、压缩步骤模型推断、面板内更新（手动 / 自动 / 关闭）及缓存重建与配置重置。

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
      <sub>终端底栏单行 24-bit ANSI 无背景色 <code>statusLine</code>，显示活跃会话数、输出速率、首字延迟与上下文占比</sub>
    </td>
  </tr>
</table>

### 面板标签页

<table>
  <tr>
    <td align="center" width="33.3%">
      <img src="assets/context.png" alt="实时监控与上下文窗口" />
      <br />
      <b>实时监控</b>
      <br />
      <sub>输出速率、首字延迟、10 类上下文明细、配额池与运行中任务</sub>
    </td>
    <td align="center" width="33.3%">
      <img src="assets/analytics.png" alt="历史用量与趋势统计" />
      <br />
      <b>用量统计</b>
      <br />
      <sub>Token 汇总、缓存命中率、趋势曲线与分模型用量排行</sub>
    </td>
    <td align="center" width="33.3%">
      <img src="assets/subagents.png" alt="主代理与子代理调用明细" />
      <br />
      <b>调用明细</b>
      <br />
      <sub>按步列出代理归属、模型、速率、首字延迟、Token 构成与费用</sub>
    </td>
  </tr>
</table>

---

## 客户端支持

| 客户端 / 运行环境 | 状态胶囊 / 底栏 | 监控面板 | 离线 SQLite 与日志读取 | 按模型上下文限制 | 修改 `app.asar` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Antigravity 2.0 桌面端** | 顶栏 / 输入框停靠 | 悬浮窗 + 右侧辅助栏 | 支持 | 请求级重写钩子 | 否 |
| **Antigravity IDE** | 顶栏 / 输入框停靠 | 点击胶囊展开面板 | 支持 | 请求级重写钩子 | 否 |
| **Antigravity CLI (`agy`)** | 终端底栏 `statusLine` | 独立 Web (`--port`) | 支持（`node:sqlite` + `.pbtxt`） | `AGY_CLI_AUTO_COMPACT_OVERRIDE` | 否 |
| **无头服务器 / SSH 远程** | 终端底栏 `statusLine` | SSH 隧道 / `--token` Web | 支持 | `AGY_CLI_AUTO_COMPACT_OVERRIDE` | 否 |

> [!NOTE]
> 在 **Antigravity IDE** 中首次启用插件时，后台会通过零工具开销的 MCP 保活入口（不消耗上下文 Token）向 `~/.antigravity-ide/argv.json` 写入 `"remote-debugging-port": "0"`（保留原有注释与配置项）。首次启用后需重启一次 IDE，顶栏胶囊才能正常挂载。

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
4. **Antigravity CLI (`agy`) 底部胶囊**：
   - 检测到 `~/.gemini/antigravity-cli` 时自动写入原生 `statusLine` 配置（保留已有自定义 `statusLine.command`），在终端底栏单行显示当前活跃状态、输出速率、首字延迟与上下文占比（如 `● 1 运行中   38.1 t/s | 0.85s | ◎ 17%`）。
   - 可在 `agy` 中通过 `/statusline` 或在面板 **偏好设置 → 界面编排 → 挂载胶囊** 开关及调整显示顺序。
5. **独立 Web 服务（纯终端 / 远程服务器）**：

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

前后端代码采用纯 Node.js ESM 与原生 Web Components 编写，**无外部 npm 依赖**（建议使用 Node.js 22.5+ 以使用内置 `node:sqlite`）。

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

### 脱敏原始计时导出

调用明细中点击首字延迟，可查看并下载单步 JSON：包含原生 TTFT、总耗时、思考/返回阶段计时、时间戳、缓存 token、可用的重试条目数和新版异常汇总。旧缓存缺少新增字段时显示未知，重新读取轨迹后补齐。工具参数、提示词、思考正文和错误正文不导出。原生计时可能重叠，不可相加；重试条目数不一定等于实际重试次数。报告不能拆出 DNS/TCP/TLS、服务端排队或 prefill 耗时，也不自动判定故障归属。新版上游异常诊断保持原样。
