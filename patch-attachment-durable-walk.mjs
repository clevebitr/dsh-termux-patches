#!/usr/bin/env node
/**
 * Termux/Android 补丁:@deepseek-ai/dsh-attachment-local 的祖先目录持久化遍历。
 *
 * 附件落盘前要把「从 DSH_HOME 一直到文件系统根」的每一级祖先目录 fsync 一遍
 * (`ensureDurableHome` → `ensureDurableDirectory(home, parse(home).root)`),每级都走
 * `open(dir, O_RDONLY)` + `sync()`,用来证明目录项本身已落盘。
 *
 * 在桌面 Linux 上没问题(home 形如 /home/user,祖先都可读)。Android 上 app 的 home 是
 * `/data/data/com.termux/files/home`,而:
 *
 *   /data/data   权限 771,属主 system  → 可穿越(x)但不可读(r)
 *   /data        同样不可读
 *   /            本机同样返回 EACCES
 *
 * 于是 `open('/data/data', O_RDONLY)` 稳定抛 `EACCES: permission denied, open '/data/data'`,
 * 整条附件提交失败。实测影响:
 *   - read_image 工具:任何图片都读不进来(报的就是上面这条 EACCES)
 *   - 聊天里粘贴/上传图片:同一条提交路径
 *
 * 修法:遍历遇到 EACCES/EPERM 就在此收手并返回——这些祖先目录由系统在安装时创建,
 * 本来就已经持久,app 既无权限也无需为它们做目录 fsync。其它 errno 照旧抛出,
 * 有权限的层级依旧逐级同步,durability 语义不变。
 *
 * 幂等:已打过补丁则直接返回 0;锚点对不上(升级后代码变了)则报错退出,交人工核对。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const NM = process.argv[2]
if (NM === undefined) {
  console.error('用法: node patch-attachment-durable-walk.mjs <node_modules 路径>')
  process.exit(2)
}
const target = join(NM, '@deepseek-ai/dsh-attachment-local/lib/index.js')

const MARKER = 'system-owned ancestors'

const WALK_ANCHOR = `\tlet level = target;
\twhile (level !== stop) {
\t\tconst parent = dirname(level);
\t\tawait syncDirectory(parent);
\t\t/* v8 ignore next -- filesystem-root guard: callers pass a boundary that is an ancestor of path, so the walk reaches it first. */
\t\tif (parent === level) return;
\t\tlevel = parent;
\t}
`

const WALK_REPLACEMENT = `\tlet level = target;
\twhile (level !== stop) {
\t\tconst parent = dirname(level);
\t\ttry {
\t\t\tawait syncDirectory(parent);
\t\t} catch (error) {
\t\t\t/* Android/Termux: an app's home lives under system-owned ancestors — /data/data is mode 771
\t\t\t   (traversable, not readable), so open(dir, O_RDONLY) fails with EACCES even though the app
\t\t\t   owns everything below it. Those directories were created by the OS at install time and are
\t\t\t   durable by construction, so stop the walk instead of failing the whole attachment commit. */
\t\t\tif (error?.code === "EACCES" || error?.code === "EPERM") return;
\t\t\tthrow error;
\t\t}
\t\t/* v8 ignore next -- filesystem-root guard: callers pass a boundary that is an ancestor of path, so the walk reaches it first. */
\t\tif (parent === level) return;
\t\tlevel = parent;
\t}
`

const source = await readFile(target, 'utf8')

if (source.includes(MARKER)) {
  console.log('attachment-durable: Android 降级补丁已存在,跳过')
  process.exit(0)
}
if (!source.includes(WALK_ANCHOR)) {
  console.error(`attachment-durable: 找不到遍历锚点,${target} 可能已随版本变化,请人工核对后再打`)
  process.exit(1)
}

await writeFile(target, source.replace(WALK_ANCHOR, WALK_REPLACEMENT), 'utf8')
console.log('attachment-durable: 已注入 Android 降级(祖先目录不可读时停止遍历)')
