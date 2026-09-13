#!/data/data/com.termux/files/usr/bin/bash
# dsh Termux 补丁重放:npm 重装或升级 dsh 后运行本脚本恢复 Android 适配。
# 升级到新版本 dsh 时内部代码可能已变,直接覆盖 JS 备份有风险:
# 脚本会在版本不匹配时警告,请先人工核对(参考 Claude 记忆 project_dsh_termux.md)。
set -euo pipefail

PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_ROOT="$(dirname "$PATCH_DIR")"
NM="$DSH_ROOT/node_modules"
[ -d "$NM" ] || { echo "找不到 $NM,先安装 dsh"; exit 1; }

ver() { node -p "require('$1/package.json').version"; }
base() { grep "^$1=" "$PATCH_DIR/versions.txt" | cut -d= -f2; }

CUR_DSH="$(ver "$NM/@deepseek-ai/dsh")"
BASE_DSH="$(base dsh)"
if [ "$CUR_DSH" != "$BASE_DSH" ]; then
  echo "⚠️  当前 dsh $CUR_DSH ≠ 备份对应版本 $BASE_DSH"
  echo "    JS 补丁(flock/会话/附件)可能不适用新版本,建议先人工 diff 核对。"
  read -r -p "   仍要复制 JS 补丁?(y/N) " a
  [ "$a" = y ] || exit 1
fi

# 1. node-pty android-arm64 预编译二进制(核心 + web profile 两处)
PTY_VER="$(ver "$NM/node-pty")"
echo "[1/8] node-pty $PTY_VER: android-arm64/pty.node"
if [ "$PTY_VER" != "$(base node-pty)" ]; then
  echo "⚠️  node-pty 版本与备份($(base node-pty))不同,预编译二进制可能不兼容,需重新编译"
fi
mkdir -p "$NM/node-pty/prebuilds/android-arm64"
cp "$PATCH_DIR/pty.node" "$NM/node-pty/prebuilds/android-arm64/pty.node"

# dsh-web 聚合包里的 better-sidebar 也用 node-pty(profile 侧经 overrides 钉在与核心同一版本),
# 插件自身要求缺原生模块时"node-pty 与 DSH 核心保持同一版本",所以复用同一份预编译。
PROFILE_NM="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules"
if [ -d "$PROFILE_NM/node-pty" ]; then
  PROFILE_PTY_VER="$(ver "$PROFILE_NM/node-pty")"
  echo "      profile 侧 node-pty $PROFILE_PTY_VER"
  if [ "$PROFILE_PTY_VER" != "$(base node-pty)" ]; then
    echo "⚠️  profile 的 node-pty($PROFILE_PTY_VER)≠ 备份版本($(base node-pty)),预编译二进制可能不兼容"
  fi
  mkdir -p "$PROFILE_NM/node-pty/prebuilds/android-arm64"
  cp "$PATCH_DIR/pty.node" "$PROFILE_NM/node-pty/prebuilds/android-arm64/pty.node"
fi

# 2. sharp wasm32(版本须与 sharp 一致)
SHARP_VER="$(ver "$NM/sharp")"
echo "[2/8] sharp $SHARP_VER: 安装 @img/sharp-wasm32@$SHARP_VER"
(cd "$DSH_ROOT" && npm install "@img/sharp-wasm32@$SHARP_VER" --ignore-scripts --no-audit --no-fund)

# 3. flock → koffi FFI(Android bionic 走 libc flock)
echo "[3/8] flock.js(koffi FFI 补丁)"
cp "$PATCH_DIR/flock.js" "$NM/@deepseek-ai/node-addon-system/lib/flock.js"

# 4. 硬链接降级(Android SELinux 禁 link)
echo "[4/8] 硬链接降级(session-persistence-jsonl / attachment-local)"
cp "$PATCH_DIR/session-persistence-jsonl.index.js" "$NM/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js"
cp "$PATCH_DIR/attachment-local.index.js" "$NM/@deepseek-ai/dsh-attachment-local/lib/index.js"

# 5. dsh 命令 wrapper(--expose-internals for HMR)
echo "[5/8] dsh wrapper → \$PREFIX/bin/dsh"
cp "$PATCH_DIR/wrapper-dsh" "$PREFIX/bin/dsh"
chmod +x "$PREFIX/bin/dsh"

# 6. 浏览器 cookie SameSite=Strict → Lax
#    Android 上 dsh web 的自动打开是「别的 App 拉起浏览器」(termux-open → ACTION_VIEW),
#    这类外部发起的顶层导航里,303 跳到 / 的那一跳不会带上 SameSite=Strict 的 cookie,
#    于是必然落到 401 "dsh web authentication required; reopen the URL printed by dsh web"。
#    只影响 $DSH_HOME/.credentials.yaml 里那把密钥签发的会话 cookie 的携带条件;
#    服务仍只绑 127.0.0.1,API 另有 Host/Origin 围栏。
echo "[6/8] client-connection cookie SameSite=Strict → Lax"
CONN="$NM/@deepseek-ai/dsh-client-connection/lib/index.js"
if grep -q "SameSite=Strict" "$CONN"; then
  sed -i 's/SameSite=Strict/SameSite=Lax/' "$CONN"
fi
grep -q "SameSite=Lax" "$CONN" || { echo "⚠️  未在 $CONN 找到 SameSite 标记,新版本可能已改,请人工核对"; exit 1; }

# 7. fs-local 新建文件的发布路径:硬链接不可用(SELinux)时降级为 open(wx) 占名 + rename。
#    不打这个补丁,write 工具创建任何新文件都会以
#    "EACCES: permission denied, link ..." 失败(覆盖已有文件走 rename,不受影响)。
echo "[7/8] fs-local 硬链接降级(write 工具建新文件)"
node "$PATCH_DIR/patch-fs-local.mjs" "$NM"

# 8. 会话发布降级的兜底与锚点断言。
#    session-persistence-jsonl 有两份产物:lib/index.js(第 4 步覆盖)与 lib/worker.cjs
#    (迁移校验 worker 的整图 bundle)。后者同样带着一份 publishCurrentExclusive,却没有
#    降级分支;当前 worker 只做只读校验、不发布,所以那份副本暂时不可达,属于"升级后可能
#    静默复活"的隐患。这里补上降级,并直接断言产物本身:任何 link() 发布点后方 12 行内
#    必须出现降级分支,否则中止重放交人工核对(npm 重装会让上游代码原样回来)。
echo "[8/8] 会话发布降级(worker.cjs)+ 硬链接降级锚点断言"
node "$PATCH_DIR/patch-session-worker.mjs" "$NM"
node "$PATCH_DIR/check-session-publish-fallback.mjs" "$NM"

echo "✅ 补丁重放完成。验证:dsh --version && dsh web --no-open --port 3085"
