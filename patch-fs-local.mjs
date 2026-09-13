#!/usr/bin/env node
/**
 * Termux/Android 补丁:@deepseek-ai/dsh-fs-local 的新建文件发布路径默认用硬链接
 * (`link(staged, target)`) 实现 no-replace 语义,而 Android SELinux 在 app 数据目录
 * 直接禁止 link()(稳定返回 EACCES),于是 write 工具创建任何新文件都会以
 * "EACCES: permission denied, link ..." 失败(覆盖已有文件走 rename,不受影响)。
 *
 * 与 session-persistence-jsonl / attachment-local 两个补丁同一套思路:
 * link 不可用时,先用 open(target, "wx") 独占占名,再把已 fsync 的暂存文件 rename 过去。
 * `wx` 遇到并发创建者仍以 EEXIST 失败,所以"不覆盖他人字节"的保证不变,
 * 弱化的只是可见性:读者可能瞬间看到一个已占名但为空的文件。
 *
 * 幂等:已打过补丁则直接返回 0;锚点对不上(升级后代码变了)则报错退出,交人工核对。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const NM = process.argv[2]
if (NM === undefined) {
  console.error('用法: node patch-fs-local.mjs <node_modules 路径>')
  process.exit(2)
}
const target = join(NM, '@deepseek-ai/dsh-fs-local/lib/index.js')

const HELPER_ANCHOR = `function isPermissionError(error) {
	return error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}
`

const HELPER = `/** Android/SELinux forbids hard links outright (EACCES even within one's own directory); publishNewFile falls back to an exclusive claim plus rename. */
function isHardlinkUnsupported(error) {
	return error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTSUP" || error.code === "EOPNOTSUPP" || error.code === "EXDEV");
}
`

const PUBLISH_ANCHOR = `		if (createIfAbsent !== void 0) try {
			await linkFile(tempPath, absolutePath);
		} catch (error) {
			await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
		}
`

const PUBLISH_REPLACEMENT = `		if (createIfAbsent !== void 0) try {
			await linkFile(tempPath, absolutePath);
		} catch (error) {
			if (isHardlinkUnsupported(error)) {
				/* Android/SELinux forbids hard links, so the no-replace link can never succeed here. Claim the name with an exclusive create, then rename the synced staging file over that own claim: \`wx\` still loses to a concurrent creator with EEXIST, so no other writer's bytes are clobbered. A genuine permission fault resurfaces through the failed claim's own classification. */
				try {
					const claim = await open(absolutePath, "wx", 384);
					await claim.close();
				} catch (claimError) {
					await throwGuardedCreateFailure(claimError, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
				}
				try {
					await rename(tempPath, absolutePath);
				} catch (publishError) {
					await rm(absolutePath, { force: true }).catch(() => {});
					throw publishError;
				}
			} else await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
		}
`

const source = await readFile(target, 'utf8')

if (source.includes('function isHardlinkUnsupported(')) {
  console.log('fs-local: 硬链接降级补丁已存在,跳过')
  process.exit(0)
}
if (!source.includes(HELPER_ANCHOR) || !source.includes(PUBLISH_ANCHOR)) {
  console.error(`fs-local: 找不到补丁锚点,${target} 可能已随版本变化,请人工核对后再打`)
  process.exit(1)
}

const patched = source
  .replace(HELPER_ANCHOR, HELPER_ANCHOR + HELPER)
  .replace(PUBLISH_ANCHOR, PUBLISH_REPLACEMENT)

await writeFile(target, patched, 'utf8')
console.log('fs-local: 已注入硬链接降级(open wx 占名 + rename 发布)')
