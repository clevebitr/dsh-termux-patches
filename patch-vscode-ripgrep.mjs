#!/usr/bin/env node
/**
 * Termux/Android 补丁:@vscode/ripgrep —— glob / grep 工具的 ripgrep 解析。
 *
 * `@vscode/ripgrep` 只是个按平台转发的空壳:`process.platform`/`process.arch` 拼出
 * `@vscode/ripgrep-${platform}-${arch}` 再 `require.resolve` 它的 `bin/rg`。而它的
 * optionalDependencies 只覆盖 linux/darwin/win32——**没有 android 目标**。于是 Termux 上:
 *
 *   platformPkg = @vscode/ripgrep-android-arm64   → require.resolve 抛错
 *   → import("@vscode/ripgrep") 的 promise 被拒绝
 *   → dsh-tool-fs-search 的 resolveRgPath() 拒绝
 *   → glob/grep 报 "could not start its search command (ripgrep launch failed)"
 *
 * 换成 linux-arm64 也不行:那是 glibc 动态链接的二进制,bionic 上根本起不来。
 * 所以这里降级到 PATH 上的 bionic 原生 ripgrep(Termux: `pkg install ripgrep`),
 * 或用 DSH_RIPGREP_PATH 指定绝对路径。仅在 android 平台生效,其它平台行为不变。
 *
 * 注意:`dsh-tool-fs-search` 把 resolveRgPath() 的结果按进程 memoize(失败的 promise
 * 也是),所以补丁只对**新启动的进程**生效——打完要重启 dsh web。
 *
 * 幂等:已打过补丁则直接返回 0;锚点对不上(升级后代码变了)则报错退出,交人工核对。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const NM = process.argv[2]
if (NM === undefined) {
  console.error('用法: node patch-vscode-ripgrep.mjs <node_modules 路径>')
  process.exit(2)
}
const target = join(NM, '@vscode/ripgrep/lib/index.js')

const IMPORT_ANCHOR = `import { createRequire } from 'node:module';
`

const IMPORT_ADDITION = `import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
`

const PKG_ANCHOR = `const platformPkg = \`@vscode/ripgrep-\${process.platform}-\${arch}\`;
`

const HELPER = `
/**
 * Android/Termux 降级:官方只发布 linux/darwin/win32 目标,android-arm64 不存在,
 * 而 glibc 的 linux-arm64 二进制在 bionic 上跑不起来。改用 PATH 上的原生 ripgrep
 * (Termux: pkg install ripgrep),或用 DSH_RIPGREP_PATH 指定。
 */
function resolveAndroidRg() {
    if (process.platform !== 'android') return undefined;
    const override = process.env.DSH_RIPGREP_PATH;
    if (override !== undefined && override !== '' && isExecutableFile(override)) return override;
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        if (dir === '') continue;
        const candidate = join(dir, binaryName);
        if (isExecutableFile(candidate)) return candidate;
    }
    return undefined;
}

function isExecutableFile(path) {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
`

const RESOLVE_ANCHOR = `let resolved;
try {
    resolved = require.resolve(\`\${platformPkg}/bin/\${binaryName}\`);
} catch {
    throw new Error(
        \`Could not find \${platformPkg}. \` +
        \`Ensure optionalDependencies are installed for this platform (\${process.platform}-\${arch}).\`
    );
}
`

const RESOLVE_REPLACEMENT = `let resolved;
try {
    resolved = require.resolve(\`\${platformPkg}/bin/\${binaryName}\`);
} catch (error) {
    const androidRg = resolveAndroidRg();
    if (androidRg === undefined) {
        throw new Error(
            \`Could not find \${platformPkg}. \` +
            \`Ensure optionalDependencies are installed for this platform (\${process.platform}-\${arch}).\` +
            (process.platform === 'android'
                ? ' Android/Termux publishes no ripgrep target: install the native package (Termux: pkg install ripgrep) or set DSH_RIPGREP_PATH.'
                : ''),
            { cause: error }
        );
    }
    resolved = androidRg;
}
`

const source = await readFile(target, 'utf8')

if (source.includes('function resolveAndroidRg(')) {
  console.log('vscode-ripgrep: Android 降级补丁已存在,跳过')
  process.exit(0)
}
for (const [label, anchor] of [
  ['import', IMPORT_ANCHOR],
  ['platformPkg', PKG_ANCHOR],
  ['resolve', RESOLVE_ANCHOR],
]) {
  if (!source.includes(anchor)) {
    console.error(`vscode-ripgrep: 找不到 ${label} 锚点,${target} 可能已随版本变化,请人工核对后再打`)
    process.exit(1)
  }
}

const patched = source
  .replace(IMPORT_ANCHOR, IMPORT_ANCHOR + IMPORT_ADDITION)
  .replace(PKG_ANCHOR, PKG_ANCHOR + HELPER)
  .replace(RESOLVE_ANCHOR, RESOLVE_REPLACEMENT)

await writeFile(target, patched, 'utf8')
console.log('vscode-ripgrep: 已注入 Android 降级(rgPath 回退到 PATH 上的原生 rg)')
