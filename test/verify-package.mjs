/**
 * 打包前校验：把评审反复抓到的几类「打包事故」变成硬检查。
 * 用法：ELECTRON_RUN_AS_NODE=1 <electron> test/verify-package.mjs
 * 任何一项失败都以非零退出。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0

function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('== 1. package.json ==')
{
  const p = join(ROOT, 'package.json')
  const bytes = readFileSync(p)
  const hasBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
  check('无 UTF-8 BOM（BOM 会让 DSH 静默跳过整个 bundle）', !hasBom)
  let pkg
  try { pkg = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); check('可被 JSON.parse', true) }
  catch (error) { check('可被 JSON.parse', false, error.message); pkg = {} }
  check('name 为 @local/desktop-control', pkg.name === '@local/desktop-control', pkg.name)
  check('声明了 dsh.bundle.patch', Boolean(pkg.dsh?.bundle?.patch), JSON.stringify(pkg.dsh))
  check('files 覆盖 index.js 与 native', (pkg.files ?? []).includes('index.js') && (pkg.files ?? []).includes('native/DesktopControl.exe'))
}

console.log('\n== 2. 源文件换行统一（LF）==')
for (const file of ['index.js', 'native/DesktopControl.cs', 'test/smoke.mjs', 'test/audit.mjs', 'cordis.patch.yml']) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const crlf = (text.match(/\r\n/g) ?? []).length
  check(`${file} 无 CRLF`, crlf === 0, `${crlf} 处`)
}

console.log('\n== 3. 必需文件存在 ==')
for (const file of [
  'index.js', 'cordis.patch.yml', 'package.json', 'icon.svg',
  'locale/en.json', 'locale/zh.json', 'docs/DETAIL.md',
  'native/DesktopControl.cs', 'native/DesktopControl.exe',
  'test/smoke.mjs', 'test/audit.mjs',
]) {
  check(file, existsSync(join(ROOT, file)))
}

console.log('\n== 4. 报告与版本一致 ==')
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
  const version = pkg.version
  const reportDir = join(ROOT, 'docs')
  // 只认当前版本的报告名：回退到旧版本会让「报告与版本一致」这条检查形同虚设。
  const reportPath = join(reportDir, `FIX-REPORT-v${version}.md`)
  check(`报告文件名与版本一致（FIX-REPORT-v${version}.md）`, existsSync(reportPath), reportPath)
  if (reportPath) {
    const report = readFileSync(reportPath, 'utf8')
    check('报告头部写了当前版本', report.includes(`@local/desktop-control\` ${version}`), reportPath.split('\\').pop())
    check('报告里只有一个「交付物」结尾', (report.match(/\*\*交付物\*\*/g) ?? []).length === 1, String((report.match(/\*\*交付物\*\*/g) ?? []).length))
    const appendix = report.slice(report.indexOf('## 附录'))
    check('附录不再含硬编码行号', !/`:\d+`/.test(appendix))
  }
}

console.log('\n== 5. 编译产物比源码新 ==')
{
  // 方法名在 .NET 元数据里，不是字符串字面量，搜字节不可靠（v1.1.3 这里就误判过）。
  // 直接比 mtime：exe 必须不早于 .cs。
  const csStat = statSync(join(ROOT, 'native', 'DesktopControl.cs'))
  const exeStat = statSync(join(ROOT, 'native', 'DesktopControl.exe'))
  check(
    'exe 不早于 C# 源码修改时间',
    exeStat.mtimeMs >= csStat.mtimeMs - 1000,
    `exe=${new Date(exeStat.mtimeMs).toISOString()} cs=${new Date(csStat.mtimeMs).toISOString()}`,
  )
  check('exe 体积合理（> 20KB）', exeStat.size > 20000, `${exeStat.size} bytes`)
}

console.log(`\n结果：${failures === 0 ? '打包校验通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
