# dsh-termux-patches

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）在 **Android / Termux** 上的兼容补丁集。

Android 给 dsh 制造了几处 Linux 上不存在的障碍：app 数据目录受 SELinux 限制**禁止 `link()`**、bionic 没有 glibc、node-pty 与 ripgrep 都不发布 android-arm64、pnpm 的构建门禁与硬链接导入都会失败。本仓库把每一处改动固化成**幂等可重放**的补丁，npm 重装或升级 dsh 后一条命令即可恢复。

## 用法

```sh
bash apply.sh      # 全部步骤幂等；dsh 版本与 versions.txt 不一致时会警告并要求人工确认
dsh --version && dsh web --no-open --port 3085   # 验证
```

`apply.sh` 会把改动直接写进 `node_modules`，所以**升级 dsh 后需要重放**。脚本对每个补丁都做了锚点/幂等检查：找不到锚点会报错退出交人工核对，已打过则跳过。末尾三步还会做行为断言——硬链接降级覆盖完好（补丁 8）、ripgrep 真的能启动并搜索（补丁 9）、附件持久化遍历真的跑得通（补丁 10）——产物被上游还原时直接非零退出中止。

## 补丁清单

| # | 目标 | 在 Android 上的症状 | 做法 |
| --- | --- | --- | --- |
| 1 | `node-pty` | 无 android-arm64 预编译，node-gyp 需要 NDK | 铺入自行构建的 `pty.node`；核心与 web profile（dsh-web 的 better-sidebar 也用）两处 |
| 2 | `sharp` | 原生 sharp 无法编译 | 改装 `@img/sharp-wasm32`（版本须与 sharp 一致） |
| 3 | `node-addon-system/flock` | bionic 上原生 flock 加载失败 | 换成 koffi FFI 走 libc `flock` |
| 4 | `dsh-session-persistence-jsonl` / `dsh-attachment-local` | SELinux 禁止 `link()`，新建文件/附件发布直接 `EACCES` | link 不可用时降级为 `rename` / 独占复制 |
| 5 | `dsh` 启动 wrapper | web profile 的 HMR 插件要求 `--expose-internals` | `$PREFIX/bin/dsh` 包装脚本 |
| 6 | `dsh-client-connection` 的会话 cookie | 由别的 App 拉起浏览器（`termux-open` → ACTION_VIEW）时，303 跳转那一跳**不带 `SameSite=Strict` cookie**，必然落到 `dsh web authentication required` 401 | `SameSite=Strict` → `Lax`（服务仍只绑 127.0.0.1，API 另有 Host/Origin 围栏） |
| 7 | `dsh-fs-local` | `write` 工具创建**新**文件必失败：`EACCES: permission denied, link ...`（覆盖已有文件走 rename，不受影响） | `link` 不可用时先用 `open(wx)` 独占占名，再把已 fsync 的暂存文件 `rename` 过去——并发保护（`EEXIST` → `FS_NOT_OBSERVED`）不变 |
| 8 | `dsh-session-persistence-jsonl/lib/worker.cjs` + 锚点断言 | 同一个 `publishCurrentExclusive` 在 worker bundle 里**没有**降级分支（该 worker 是迁移校验器，只读不发布，所以暂时不可达——但升级后可能静默复活成 `EACCES`） | 原地注入同样的降级；并由 `check-session-publish-fallback.mjs` 断言"任何 `link()` 发布点后方必须有降级分支"，让这类回归在重放阶段就中止 |
| 9 | `@vscode/ripgrep` | `glob` / `grep` **全部失败**：`could not start its search command (ripgrep launch failed)`。该包按 `@vscode/ripgrep-<platform>-<arch>` 转发，而它只发布 linux/darwin/win32——**没有 android 目标**；换 linux-arm64 也不行（glibc 二进制在 bionic 上起不来） | `rgPath` 在 android 平台降级到 PATH 里的原生 `rg`（`pkg install ripgrep`）或 `DSH_RIPGREP_PATH`；`check-ripgrep.mjs` 走同一解析入口并真跑一次 `--no-config --json` 搜索 |
| 10 | `dsh-attachment-local` | `read_image` 与聊天贴图**全部失败**：`EACCES: permission denied, open '/data/data'`。附件落盘前要把 home 到 `/` 的每级祖先目录 fsync 一遍，而 Android 上 `/data/data` 是 771（可穿越不可读），`open(dir, O_RDONLY)` 必失败 | 遍历遇到 `EACCES`/`EPERM` 即收手（系统属主的祖先在安装时已持久，app 既无权限也无需同步）；`check-attachment-durable.mjs` 把产物里的遍历函数抠出来，用真实 `DSH_HOME` 与真实边界跑一遍 |

> 断言检查的是**产物本身**而不是"补丁脚本跑过没有"：`session-persistence-jsonl` 的两份产物、`attachment-local` 的结构断言，外加 `fs-local` 的降级函数存在性。所以 npm 重装把上游代码原样带回来时，`apply.sh` 会以非零退出中止，而不是留着一个只在真机上才炸的缺口。

## 已验证的行为（2026-09，dsh 0.1.5-rc.1）

- 本机 app 数据目录内裸 `link()` 稳定返回 `EACCES`（`errno=-13`），`rename` / `open(wx)` 正常——补丁前提成立。
- `flock` 补丁（koffi → libc）跨进程互斥有效：A 持锁期间 B、C 均 `EAGAIN`（`errno=11`）。
- 把两份产物里的 `publishCurrentExclusive` 抠出来用真实 fs 驱动（即 `link` 必然 EACCES 的路径）：目标不存在时降级 `rename` 发布成功、暂存被清理；目标已存在时返回 `false` 且不覆盖他人字节——独占语义不变。
- 会话载入（`open(id,"read")`）不发布、不写盘、不 spawn 校验 worker：旧格式会话的迁移是惰性的（`prepareStoredMigration` 只解码到内存），只有以 `write` 打开才会落盘发布。
- ripgrep：`process.platform` 是 `android`，`import("@vscode/ripgrep")` 抛 `Could not find @vscode/ripgrep-android-arm64`；打补丁后解析到 `/data/data/com.termux/files/usr/bin/rg`（Termux 包 ripgrep 15.2.0），`--no-config --json` 搜索探针通过。
- 该解析结果在 `dsh-tool-fs-search` 里按进程 memoize（失败也 memoize），所以补丁 9 **只对新启动的进程生效**——打完要重启 dsh web。
- 附件祖先遍历：本机 `open('/data/data', O_RDONLY)` → `EACCES`（该目录 771/system），`/data`、`/` 同样不可读；逐级实测 `/data/data/com.termux/files/home`、`.../files`、`.../com.termux` 可读，再往上就断。补丁前 `read_image` 稳定复现该 EACCES，补丁后遍历正常返回并建出 `~/.dsh/attachments/v1`。
- 该遍历函数在模块加载时被引用，所以补丁 10 同样是**重启后生效**。
- 同类模式扫过一遍：只有 `dsh-attachment-local` 会一路走到文件系统根；会话持久化只 fsync 单级父目录（`~/.dsh/sessions`，可读），Windows 另有一套 `ensureDurableDirectoryWin32`。

## 版本对应

`versions.txt` 记录补丁对应的版本，不匹配时 `apply.sh` 会警告：

```
dsh=0.1.5-rc.1
node-pty=1.2.0-beta.15
sharp=0.35.4
```

## 目录

```
apply.sh                          补丁重放主脚本（10 步，幂等）
versions.txt                      对应版本
pty.node                          android-arm64 预编译（node-pty 1.2.0-beta.15）
flock.js                          koffi FFI 版 flock
session-persistence-jsonl.index.js  / attachment-local.index.js   硬链接降级后的整文件副本
patch-fs-local.mjs                fs-local 硬链接降级（带锚点校验的原地补丁器）
patch-session-worker.mjs          worker.cjs 硬链接降级（带锚点校验的原地补丁器）
check-session-publish-fallback.mjs 锚点断言：每个 link() 发布点都必须带降级分支
patch-vscode-ripgrep.mjs          @vscode/ripgrep 的 rgPath 降级到原生 rg
check-ripgrep.mjs                 断言：rgPath 可执行、能启动、--json 搜索可用
patch-attachment-durable-walk.mjs 附件祖先目录遍历遇到不可读祖先即收手
check-attachment-durable.mjs      断言：用真实 DSH_HOME 跑通附件持久化遍历
wrapper-dsh                       $PREFIX/bin/dsh 包装脚本
dsh-web-notes.md                  dsh-web 插件生态在 Termux 上的安装裁决（pnpm allowBuilds / node-pty 对齐 / cloudflared 取舍）
```

## 另见

- `dsh-web-notes.md`：安装 [dsh-web](https://github.com/zhu1090093659/dsh-web) 插件全家桶时的 Termux 裁决记录（pnpm 11 只认 `allowBuilds` 布尔映射、`node-pty` 与核心对齐、cloudflared 在 bionic 上不可用等）。

## 来源与许可

- `session-persistence-jsonl.index.js`、`attachment-local.index.js` 派生自 MIT 许可的 `@deepseek-ai/dsh-session-persistence-jsonl`、`@deepseek-ai/dsh-attachment-local`（版权归 DeepSeek）。
- `flock.js` 派生自 **BSD-3-Clause** 许可的 `@deepseek-ai/node-addon-system`。
- `pty.node` 由 MIT 许可的 [node-pty](https://github.com/microsoft/node-pty) 1.2.0-beta.15 为 android-arm64 构建。
- 其余脚本与文档：MIT（见 `LICENSE`）。
