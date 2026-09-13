# dsh-termux-patches

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）在 **Android / Termux** 上的兼容补丁集。

Android 给 dsh 制造了几处 Linux 上不存在的障碍：app 数据目录受 SELinux 限制**禁止 `link()`**、bionic 没有 glibc、node-pty 不发布 android-arm64 预编译、pnpm 的构建门禁与硬链接导入都会失败。本仓库把每一处改动固化成**幂等可重放**的补丁，npm 重装或升级 dsh 后一条命令即可恢复。

## 用法

```sh
bash apply.sh      # 全部步骤幂等；dsh 版本与 versions.txt 不一致时会警告并要求人工确认
dsh --version && dsh web --no-open --port 3085   # 验证
```

`apply.sh` 会把改动直接写进 `node_modules`，所以**升级 dsh 后需要重放**。脚本对每个补丁都做了锚点/幂等检查：找不到锚点会报错退出交人工核对，已打过则跳过。

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

## 版本对应

`versions.txt` 记录补丁对应的版本，不匹配时 `apply.sh` 会警告：

```
dsh=0.1.5-rc.1
node-pty=1.2.0-beta.15
sharp=0.35.4
```

## 目录

```
apply.sh                          补丁重放主脚本（7 步，幂等）
versions.txt                      对应版本
pty.node                          android-arm64 预编译（node-pty 1.2.0-beta.15）
flock.js                          koffi FFI 版 flock
session-persistence-jsonl.index.js  / attachment-local.index.js   硬链接降级后的整文件副本
patch-fs-local.mjs                fs-local 硬链接降级（带锚点校验的原地补丁器）
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
