#!/usr/bin/env node
/**
 * Termux/Android 补丁:@deepseek-ai/dsh-session-persistence-jsonl 的 worker bundle。
 *
 * npm 包里有两份产物:`lib/index.js`(主入口,补丁 #4 覆盖)与 `lib/worker.cjs`
 * (迁移校验 worker 的 CJS bundle)。后者是整棵依赖图重新打包出来的,里面同样带着
 * 一份 `publishCurrentExclusive`,但**没有**硬链接降级分支——只处理 EEXIST,其余
 * errno 原样抛出。Android SELinux 在 app 数据目录稳定返回 EACCES,所以这份副本
 * 一旦被执行,发布就会以 "EACCES: permission denied, link ..." 失败。
 *
 * 现状:worker 入口只做只读校验(`verifyJsonlCurrentGeneration`,只读+比对摘要并
 * 回传),不发布,因此这份副本当前不可达。本补丁是防御性的——保证"任何 link 发布
 * 都带降级",避免上游把发布挪进 worker、或补丁在升级后丢失时静默退化。
 *
 * 幂等:已打过补丁则直接返回 0;锚点对不上(升级后代码变了)则报错退出,交人工核对。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const NM = process.argv[2]
if (NM === undefined) {
  console.error('用法: node patch-session-worker.mjs <node_modules 路径>')
  process.exit(2)
}
const target = join(NM, '@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs')

const HELPER_ANCHOR = `function isEEXIST(error) {
\treturn error?.code === "EEXIST";
}
`

const HELPER = `/** Android/SELinux forbids hard links outright (EACCES even within one's own directory); publishCurrentExclusive falls back to an existence check plus rename. */
function isHardlinkUnsupported(error) {
\tconst code = error?.code;
\treturn code === "EACCES" || code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV";
}
`

const PUBLISH_ANCHOR = `\ttry {
\t\tawait internals.fs.link(staged, currentPath);
\t} catch (error) {
\t\t/* v8 ignore else -- a non-collision filesystem error propagates unchanged. */
\t\tif (isEEXIST(error)) return false;
\t\t/* v8 ignore next -- the filesystem error is already complete. */
\t\tthrow error;
\t}
`

const PUBLISH_REPLACEMENT = `\ttry {
\t\tawait internals.fs.link(staged, currentPath);
\t} catch (error) {
\t\t/* v8 ignore else -- a non-collision filesystem error propagates unchanged. */
\t\tif (isEEXIST(error)) return false;
\t\tif (isHardlinkUnsupported(error)) {
\t\t\t/* Android/SELinux forbids hard links: emulate exclusive publish with an existence check plus rename. */
\t\t\tconst exists = await internals.fs.lstat(currentPath).then(() => true, () => false);
\t\t\tif (exists) return false;
\t\t\tawait (0, node_fs_promises.rename)(staged, currentPath);
\t\t} else {
\t\t\t/* v8 ignore next -- the filesystem error is already complete. */
\t\t\tthrow error;
\t\t}
\t}
`

const source = await readFile(target, 'utf8')

if (source.includes('function isHardlinkUnsupported(')) {
  console.log('session-worker: 硬链接降级补丁已存在,跳过')
  process.exit(0)
}
if (!source.includes(HELPER_ANCHOR) || !source.includes(PUBLISH_ANCHOR)) {
  console.error(`session-worker: 找不到补丁锚点,${target} 可能已随版本变化,请人工核对后再打`)
  process.exit(1)
}

const patched = source
  .replace(HELPER_ANCHOR, HELPER_ANCHOR + HELPER)
  .replace(PUBLISH_ANCHOR, PUBLISH_REPLACEMENT)

await writeFile(target, patched, 'utf8')
console.log('session-worker: 已注入硬链接降级(存在性检查 + rename 发布)')
