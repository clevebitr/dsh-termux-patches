# dsh-web 插件生态在 Termux 上的安装与裁决

安装命令（profile 侧，pnpm 由 `dsh plugin` 转发）：

```sh
dsh plugin --profile web add @linxin666/dsh-web-all@latest
dsh web --dump-config          # 预检:bundle 层是否登记
dsh web --no-open --port 3085  # 真机验收:另起实例,不动 3080
```

## 前置条件

- **pnpm**：`dsh plugin` 只是 pnpm 转发器，缺 pnpm 直接退出 127。本机装的是 `pnpm@11`（`npm i -g pnpm@11`）。
- **`~/.dsh/profiles/web/.npmrc`**：`package-import-method=copy`。Android SELinux 禁止在 app 数据目录 `link()`，
  pnpm 默认 hardlink 导入会失败（本项目其它补丁同一根因）。
- **`~/.dsh/profiles/web/pnpm-workspace.yaml`**：
  - `nodeLinker: hoisted`：避免 isolated 布局把 `@linxin666/*` 子包收进嵌套目录导致 `Cannot find package`。
  - `minimumReleaseAgeExclude: ['@linxin666/*']`：pnpm 11 内置发布年龄门禁会静默装回旧版皮肤插件。
  - `overrides: node-pty: 1.2.0-beta.15`：与核心 `@deepseek-ai/dsh-subprocess-local` 对齐
    （better-sidebar 的终端修复提示也要求 node-pty 与 DSH 核心同版本）。
  - `allowBuilds`：pnpm 11 只认这个**布尔映射**；`ignoredBuiltDependencies` 等 pnpm 10 键在 11 里被静默忽略。
    不写判定就会被 `ERR_PNPM_IGNORED_BUILDS` 拦成非 0，进而使 `dsh plugin` 跳过 bundle 层登记（插件装了但界面不出现）。

## 原生依赖裁决（Termux）

| 包 | 裁决 | 原因 |
| --- | --- | --- |
| node-pty | false（不编译） | 复用 `pty.node`（android-arm64 预编译，1.2.0-beta.15）；`apply.sh` 第 1 步同时铺核心与 profile 两侧 |
| cpu-features | false | node-gyp 需要 NDK；ssh2 有纯 JS 回退 |
| ssh2 | false | 同上，忽略后走 JS 实现，功能可用、速度略低 |
| cloudflared | false | 无 android 预编译，且 Termux 是 bionic，跑不了 glibc 二进制 → **公网隧道不可用，局域网配对仍可用** |

## 已验证

- `dsh web --port 3085` 干净启动，无缺包/重复 id 告警。
- 首页注入了 `@linxin666/dsh-web-all/client.js`、`dsh-better-sidebar/client.js`（bundle 15 MB / HTTP 200）。
- 皮肤宿主路由 `/api/skin-center/v2/skins/blue-fantasy/stylesheet` 返回 200。
- node-pty 真机 spawn PTY 成功（`PTY_OK_aarch64`）。
