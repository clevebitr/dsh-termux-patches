#!/usr/bin/env node
/**
 * 锚点断言(行为式):附件落盘的祖先目录持久化遍历必须在 Android 上跑得通。
 *
 * 不检查"补丁脚本跑过没有",而是把产物里的 `syncDirectory` + `ensureDurableDirectory`
 * 原样抠出来,用真实 fs、真实 DSH_HOME、真实边界(文件系统根)跑一遍:
 *   - 未打补丁:必然在 `open('/data/data', O_RDONLY)` 处抛 EACCES(这正是 read_image
 *     与聊天贴图失败的原因);
 *   - 打过补丁:遍历在系统属主的祖先处收手,函数正常返回且目标目录存在。
 *
 * 失败即 exit 1(apply.sh 有 set -e,会中止重放)。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const NM = process.argv[2]
if (NM === undefined) {
  console.error('用法: node check-attachment-durable.mjs <node_modules 路径>')
  process.exit(2)
}

const target = join(NM, '@deepseek-ai/dsh-attachment-local/lib/index.js')
const source = await readFile(target, 'utf8')

function extract(name) {
  const asyncAt = source.indexOf(`async function ${name}(`)
  const start = asyncAt >= 0 ? asyncAt : source.indexOf(`function ${name}(`)
  if (start < 0) return null
  const openBrace = source.indexOf('{', start)
  let depth = 0
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

const syncDirectory = extract('syncDirectory')
const ensureDurableDirectory = extract('ensureDurableDirectory')
if (syncDirectory === null || ensureDurableDirectory === null) {
  console.error(`✗ 无法从 ${target} 抽取持久化函数(上游可能重构,请人工核对)`)
  process.exit(1)
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-attach-check-'))
const modulePath = join(scratch, 'probe.cjs')
await writeFile(
  modulePath,
  `const { open, mkdir, chmod } = require('node:fs/promises');
const { constants } = require('node:fs');
const { resolve, dirname } = require('node:path');
${syncDirectory}
${ensureDurableDirectory}
module.exports = { ensureDurableDirectory };
`,
  'utf8',
)

const { ensureDurableDirectory: walk } = createRequire(import.meta.url)(modulePath)

// 前提核对:本机 /data/data 确实不可读(补丁存在的理由)
let premise = '前提不成立:/data/data 竟然可读'
try {
  const h = await (await import('node:fs/promises')).open('/data/data', 'r')
  await h.close()
} catch (error) {
  premise = `前提成立: open('/data/data') → ${error.code}`
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const attachmentRoot = join(dshHome, 'attachments', 'v1')

try {
  await walk(attachmentRoot, '/')
} catch (error) {
  console.error(`✗ 祖先目录持久化遍历失败: ${error.code ?? ''} ${error.message}`)
  console.error('  read_image 与聊天贴图的提交路径会因此整体失败(Android 上 app home 的上级不可读)')
  await rm(scratch, { recursive: true, force: true })
  process.exit(1)
}

if (!existsSync(attachmentRoot)) {
  console.error(`✗ 遍历返回了,但目标目录不存在: ${attachmentRoot}`)
  await rm(scratch, { recursive: true, force: true })
  process.exit(1)
}

console.log(`✓ 附件持久化遍历通过 — ${premise}`)
console.log(`  目标目录: ${attachmentRoot}`)
await rm(scratch, { recursive: true, force: true })
