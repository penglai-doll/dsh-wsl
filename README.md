# dsh-wsl

[![GitHub topics: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-7c3aed)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

DeepSeek Harness 插件：在 Windows 上通过 WSL（Windows Subsystem for Linux）执行命令。

解决两个问题：

1. **DSH 极简模式在 Windows 上不可用** —— 随包预设 `minimal-wsl`（「极简模式 (WSL)」）把极简模式的 bash 映射到 WSL，包括非持久（每次调用新 shell）与持久 PTY（保持状态、交互程序、Ctrl-C）两套实现；
2. **Windows 上的 DSH 想直接利用 WSL 环境做工程** —— 通用 `wsl` 模型工具，standard/cordis 预设的会话里从 Windows 侧直接执行一条 WSL 命令。

## 为什么极简模式在 Windows 上失败

| 失败点 | 根因 |
|---|---|
| 持久 PTY | `@deepseek-ai/dsh-subprocess-local` 在 win32 上拒绝终端进程检查（`terminal inspection is unsupported on platform win32`） |
| 非持久 bash | `@deepseek-ai/dsh-bash-local` 硬编码 `bash -c`，Windows PATH 上没有 bash |

文件系统不是问题（`dsh-fs-local` 在 Windows 上正常），问题只在 shell 执行层。本插件把执行层整体搬到 WSL，同时保留 Windows 侧的文件工具。

## 架构

```
dsh-wsl/
├── lib/
│   ├── index.js       # Host 半边：预设安装器 + 通用 wsl 工具 + /wsl-manager API
│   ├── backend.js     # 持久 PTY 的 WSL TerminalBackend（node-pty ConPTY -> wsl.exe -> Linux PTY）
│   ├── wsl.js         # 发行版探测、WSLENV 合并、预热（纯函数可测）
│   ├── path.js        # Windows ⇄ /mnt 路径转换（纯函数）
│   └── client.js      # Web 插件设置页「WSL」标签（发行版列表/预热/诊断）
├── agent-presets/
│   └── minimal-wsl/   # 随包预设：persona(路径规则) + wsl-shell 组 + persistent-shell 组 + filesystem 组
│       └── wsl-executor.mjs   # 零依赖执行器：wsl.exe [-d distro] [--cd /mnt/...] -- bash -c <cmd>
└── test/              # 单元测试（纯逻辑）+ 两个活体冒烟（需本机 WSL）
```

### 执行链路

- **非持久 bash**：`wsl-executor.mjs`（preset 本地文件，仅 Node 内置模块）在 entry-local realm 里 `ctx.provide('shell')`，`dsh-tool-bash` 注册其上。每条命令 = 一次 `wsl.exe` 调用。
- **持久 PTY**：`WslTerminalBackend` 注册进 preset 组的 `terminals` 注册表（类型 `shell`），`dsh-tool-bash-persistent` 通过它打开会话。node-pty 在 Windows 侧分配 ConPTY，wsl.exe 给 Linux bash 一个真 PTY——交互程序、Ctrl-C、作业控制原生可用（与 Windows Terminal 同机制）。命令完成检测用提示符标记（OSC 133;D + 受控 PS1 `dsh> `），静默推断与超时兜底；Linux bash 的 pid 经私有 OSC 777 序列回传，`signal()` 通过 wsl.exe 边信道读 `/proc/<pid>/stat` 解析前台进程组。

## 安装

插件需安装进 DSH 的 profile 工作区（preset 行与 profile 行都从那里解析）：

1. 把 `dsh-wsl` 加进 `C:\Users\<你>\.dsh\profiles\web\package.json` 的 dependencies：
   ```json
   "dependencies": { "dsh-wsl": "file:D:/Project/DSH-Plugins/dsh-wsl" }
   ```
2. 在该目录运行 `pnpm install`；
3. 把插件行追加到 `profiles\web\cordis.patch.yml`：
   ```yaml
   - insert:
       - id: dsh-wsl
         name: 'dsh-wsl'
   ```
4. 重启 DSH web。宿主半边会自动把 `minimal-wsl` 预设安装到 `${DSH_HOME}/.agent-presets/minimal-wsl/`（已存在则跳过，`force: true` 才覆盖）。

> 修改插件代码后，pnpm 的 file: 依赖不会自动重拷：先删除 `profiles\web\node_modules\dsh-wsl` 再重跑 `pnpm install`（或直接改 `file:` 指向的仓库内容后删除该目录）。

**前置条件**：Windows 10/11 + WSL2 + 至少一个发行版（`wsl --install`）。持久 PTY 依赖 `node-pty`（profile 工作区已随 DSH 附带）。

## 使用

1. **发行版选择**：Web 插件设置 → 插件配置 → **WSL 卡片**（横条）里用下拉框选择本地发行版（空 = WSL 默认发行版）。选择立即生效并持久化到 `settings.yaml`（`wsl.distro`），执行器、持久 PTY 后端与 wsl 工具在每次调用时读取，无需重启。
2. **极简模式 (WSL)**：Web 界面新建会话时选择该预设。bash 工具与 str_replace_editor 双工具表面与原极简模式一致，但命令在 WSL 里执行。
3. **通用 wsl 工具**：宿主半边注册的 `wsl` 工具（command/description/timeoutMs/workdir/distro 参数）。注意：DSH 的模型工具由预设行注册，宿主级注册对 preset 作用域会话可能不可见——如需在 standard/cordis 会话中使用，把 `dsh-wsl` 的工具行加进对应用户预设的组成（后续版本计划提供标准预设变体）。
4. **路径规则**（已写进预设 persona 与工具描述）：文件工具用 `D:\dir\file`，bash 命令用 `/mnt/d/dir/file`，同一份文件。
5. **沙箱**：会话切到**完全访问**后 bash/wsl 工具才放行。受限模式下会返回明确指引（WSL VM 内的进程不受 Windows 受限令牌约束，且经 /mnt/* 可达全部 Windows 文件——受限模式只会造成「看似受限」的假象）。持久 PTY 会话打开期间禁止切换沙箱模式（沿用官方后端的行为）。

## 配置

宿主半边（`cordis.patch.yml` 行的 config）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `distro` | 空 = 默认发行版 | 兜底发行版；设置页的选择（`wsl.distro`）优先 |
| `installPreset` | `true` | 自动安装 minimal-wsl 预设 |
| `force` | `false` | 预设已存在时是否覆盖刷新 |
| `registerWslTool` | `true` | 注册通用 wsl 工具 |
| `warmup` | `true` | 插件加载后预热发行版（跳过首次冷启动） |
| `settingsApi` | `true` | 提供 /wsl-manager/* 路由（状态/发行版保存/预热） |
| `terminalBackend` | `false`（显式开启） | 在 preset realm 中注册持久 PTY 后端；minimal-wsl 预设的 backend 行显式设 `true` |
| `timeoutMs` / `maxTimeoutMs` / `maxOutputBytes` / `graceMs` | 120000 / 600000 / 64000 / 3000 | wsl 工具的执行预算 |

`wsl-executor.mjs`（preset 内 `agent.cordis.yml` 的 config）：`distro`（兜底）、`timeoutMs`、`maxTimeoutMs`、`maxOutputBytes`、`maxSpillBytes`、`graceMs`。

> 实现注意：宿主半边声明 `inject: ['webServer', 'tools', 'subprocess']`。不声明 inject 的行会在这些服务就绪前激活，`ctx.get()` 全部拿空——表现为状态接口 404/兜底页与工具缺失（0.1.0 首版的线上症状）。

## 沙箱与信任模型（务必阅读）

- WSL2 是虚拟机：Windows 的受限令牌/ACL 沙箱只约束 `wsl.exe` 这个启动桩，**对 VM 内的 Linux 进程完全无效**。
- Linux 侧通过 `/mnt/*`（drvfs/9P）可以读写全部 Windows 文件。
- 因此本插件在**非完全访问模式下拒绝执行**，而不是假装受限。切换会话沙箱或让模型单次升级后放行。

## 已知限制

- **stdin 转发不支持**：wsl.exe 的 stdin 中继无法喂给 bash 内建命令（bash 启动时缓存了 EOF，之后到达的数据只有绕过 bash 缓冲区的原始读取可见——已实证）。执行器对 `stdin` 请求返回明确错误，指引改用 heredoc。
- 每次非持久调用有 ~100ms 热开销；发行版冷启动约 5–7 秒（插件自动预热一次）。
- `/mnt/*` 上重依赖构建（大量小文件 I/O）比 WSL 原生文件系统慢；工程可放 WSL 家目录（此时文件工具不可见，v2 计划支持 `\\wsl.localhost` UNC 工程目录）。
- drvfs 权限语义：文件恒为 777、chmod 无效（git/脚本在 /mnt 上仍可用）。
- 持久 PTY 不支持运行时 resize（`TerminalBackendSession` 契约本身无 resize 方法）。
- 命令行参数中的反斜杠会被 wsl.exe 吞掉，因此路径转换全部在 JS 内完成，不依赖 `wslpath`。

## 开发与测试

```bash
npm test                      # 单元测试（纯逻辑，无需 WSL）
node test/smoke-live.mjs      # 非持久执行器活体冒烟（需本机 WSL）
node test/backend-smoke-live.mjs  # 持久 PTY 活体冒烟（需本机 WSL + node-pty）
node test/tool-smoke-live.mjs     # 通用 wsl 工具活体冒烟（需本机 WSL）
```

本地跑测试需要解析 peerDependencies：仓库内 `node_modules` 是指向 profile 工作区 `node_modules` 的 junction（已被 .gitignore 忽略），按需重建：

```powershell
New-Item -ItemType Directory -Path node_modules -Force | Out-Null
New-Item -ItemType Junction -Path 'node_modules\@deepseek-ai' -Target "$env:DSH_HOME\profiles\node_modules\@deepseek-ai" -Force | Out-Null
New-Item -ItemType Junction -Path 'node_modules\node-pty' -Target "$env:DSH_HOME\profiles\node_modules\node-pty" -Force | Out-Null
```

## License

MIT
