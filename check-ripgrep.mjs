#!/usr/bin/env node
/**
 * 锚点断言(行为式):ripgrep 必须真的能解析出来、真的能跑起来。
 *
 * 不检查"补丁脚本跑过没有",而是走与 dsh-tool-fs-search 完全相同的解析入口
 * (`import("@vscode/ripgrep").rgPath`),然后:
 *   1. rgPath 存在且可执行;
 *   2. `--version` 能启动并回报 ripgrep 版本(排除 glibc 二进制在 bionic 上的
 *      "启动即失败");
 *   3. 用工具实际使用的 `--no-config --json` 组合真跑一次搜索,确认输出可用。
 *
 * 任一步失败即 exit 1(apply.sh 有 set -e,会中止重放)。
 */
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const NM = process.argv[2]
if (NM === undefined) {
  console.error('用法: node check-ripgrep.mjs <node_modules 路径>')
  process.exit(2)
}

const entry = join(NM, '@vscode/ripgrep/lib/index.js')
const hint =
  process.platform === 'android'
    ? 'Termux 上需先 `pkg install ripgrep`,或用 DSH_RIPGREP_PATH 指定原生 rg'
    : '请确认 @vscode/ripgrep 的平台包已随 optionalDependencies 安装'

let rgPath
try {
  ;({ rgPath } = await import(pathToFileURL(entry).href))
} catch (error) {
  console.error(`✗ @vscode/ripgrep 解析 rgPath 失败: ${error.message}`)
  console.error(`  ${hint}`)
  process.exit(1)
}

try {
  accessSync(rgPath, constants.X_OK)
} catch (error) {
  console.error(`✗ rgPath 不存在或不可执行: ${rgPath}(${error.code ?? error.message})`)
  console.error(`  ${hint}`)
  process.exit(1)
}

const version = spawnSync(rgPath, ['--version'], { encoding: 'utf8' })
const versionLine = (version.stdout ?? '').split('\n')[0].trim()
if (version.status !== 0 || !/^ripgrep /.test(versionLine)) {
  console.error(`✗ 无法启动 ripgrep: ${rgPath}`)
  console.error(`  status=${version.status} stdout=${JSON.stringify(versionLine)} stderr=${JSON.stringify((version.stderr ?? '').trim())}`)
  process.exit(1)
}

// 工具真实用法:`--no-config` + `--json`,在 dsh 安装根目录里搜一个必然存在的词
const probeFile = join(NM, '..', 'package.json')
const search = spawnSync(rgPath, ['--no-config', '--json', '--max-count', '1', '-e', 'name', probeFile], {
  encoding: 'utf8',
})
const matched = (search.stdout ?? '').split('\n').some((line) => line.startsWith('{') && line.includes('"match"'))
if (search.status !== 0 || !matched) {
  console.error(`✗ --json 搜索探针失败: status=${search.status}`)
  console.error(`  stderr=${JSON.stringify((search.stderr ?? '').trim())}`)
  process.exit(1)
}

console.log(`✓ ripgrep 可用: ${rgPath}`)
console.log(`  ${versionLine}`)
console.log(`  --no-config --json 搜索探针通过(${probeFile})`)
