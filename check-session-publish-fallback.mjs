#!/usr/bin/env node
/**
 * 锚点断言:凡是用硬链接发布文件的产物,都必须带 Android/SELinux 降级分支。
 *
 * 背景:Android 的 app 数据目录里 link() 稳定返回 EACCES(本机实测 errno=-13),
 * 上游代码用 link() 实现 no-replace 发布,不打补丁就会在真机上以
 * "EACCES: permission denied, link ..." 失败。补丁集用整文件副本或原地注入两种
 * 方式加降级分支,但 npm 重装 / 升级 dsh 会让它们全部回到上游状态,而"会话载入
 * 只解码不发布、worker 只校验不发布"这类当前不可达的副本又不会立刻暴露问题。
 *
 * 所以这里不检查"补丁脚本跑过没有",而是直接检查产物本身:
 *   规则 A(结构):任何代码行的 link(/linkSync( 之后 12 行内必须出现
 *                isHardlinkUnsupported —— 发布路径改了形状就会在这里失败。
 *   规则 B(存在):dsh-fs-local 的发布函数调用的是 linkFile(),规则 A 看不到,
 *                单独断言降级函数存在。
 *
 * 失败即 exit 1(apply.sh 有 set -e,会中止重放),交人工核对后再放行。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const NM = process.argv[2]
if (NM === undefined) {
  console.error('用法: node check-session-publish-fallback.mjs <node_modules 路径>')
  process.exit(2)
}

/** 结构断言:link 发布点与降级分支的搜索窗口(行) */
const WINDOW = 12
/** 前置字符断言排除 unlink/readlink/symlink/hardlink,保留 .link( 与裸 link( */
const LINK_SITE = /(?<![A-Za-z_$])link(?:Sync)?\s*\(/
const GUARD = /isHardlinkUnsupported/

const STRUCTURAL = [
  '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
  '@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs',
  '@deepseek-ai/dsh-attachment-local/lib/index.js',
]

const GUARD_PRESENCE = [
  ['@deepseek-ai/dsh-fs-local/lib/index.js', 'dsh-fs-local 的 linkFile 发布降级'],
]

const isComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line)

let failed = 0

for (const rel of STRUCTURAL) {
  const file = join(NM, rel)
  let source
  try {
    source = await readFile(file, 'utf8')
  } catch (error) {
    console.error(`✗ ${rel}: 读取失败(${error.code ?? error.message})`)
    failed += 1
    continue
  }
  const lines = source.split('\n')
  const sites = lines
    .map((line, index) => (isComment(line) || !LINK_SITE.test(line) ? -1 : index))
    .filter((index) => index >= 0)
  if (sites.length === 0) {
    console.log(`· ${rel}: 未见 link() 发布点(上游可能改了实现,请人工确认)`)
    continue
  }
  const unguarded = sites.filter(
    (index) => !lines.slice(index, index + WINDOW).some((line) => GUARD.test(line)),
  )
  if (unguarded.length > 0) {
    console.error(
      `✗ ${rel}: ${unguarded.length}/${sites.length} 处 link 发布缺少降级分支(行 ${unguarded
        .map((index) => index + 1)
        .join(', ')})`,
    )
    failed += 1
  } else {
    console.log(`✓ ${rel}: ${sites.length} 处 link 发布均带降级`)
  }
}

for (const [rel, label] of GUARD_PRESENCE) {
  const file = join(NM, rel)
  try {
    const source = await readFile(file, 'utf8')
    if (GUARD.test(source)) {
      console.log(`✓ ${rel}: ${label} 在位`)
    } else {
      console.error(`✗ ${rel}: 缺少 ${label}`)
      failed += 1
    }
  } catch (error) {
    console.error(`✗ ${rel}: 读取失败(${error.code ?? error.message})`)
    failed += 1
  }
}

if (failed > 0) {
  console.error('锚点断言失败:硬链接降级可能已随版本失效,请人工核对补丁后再重放')
  process.exit(1)
}
console.log('锚点断言通过:硬链接降级覆盖完好')
