// postinstall.mjs —— npm install 后自动下载思源黑体 CN 子集到 public/fonts/
// 源：Adobe source-han-sans 2.005R release zip（SC 命名，下载后重命名为 CN）
// 只下载一次：目标文件已存在则跳过
import { execSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const FONTS_DIR = join(PROJECT_ROOT, 'public', 'fonts')

// 需要的 4 个 SC 文件 → 重命名为 CN（CSS @font-face 里写的是 SourceHanSansCN-*.otf）
const WEIGHTS = [
  { sc: 'SourceHanSansSC-Regular.otf', cn: 'SourceHanSansCN-Regular.otf', weight: '400' },
  { sc: 'SourceHanSansSC-Medium.otf', cn: 'SourceHanSansCN-Medium.otf', weight: '500' },
  { sc: 'SourceHanSansSC-Bold.otf', cn: 'SourceHanSansCN-Bold.otf', weight: '700' },
  { sc: 'SourceHanSansSC-Heavy.otf', cn: 'SourceHanSansCN-Heavy.otf', weight: '900' },
]

const ZIP_URL =
  'https://github.com/adobe-fonts/source-han-sans/releases/download/2.005R/09_SourceHanSansSC.zip'

// 已全部存在则跳过
const allExist = WEIGHTS.every((w) => existsSync(join(FONTS_DIR, w.cn)))
if (allExist) {
  console.log('[cyrene] 思源黑体已就位，跳过下载')
  process.exit(0)
}

const tmp = mkdtempSync(join(tmpdir(), 'cyrene-fonts-'))
const zipPath = join(tmp, 'fonts.zip')

try {
  console.log('[cyrene] 下载思源黑体（首次运行，约 90MB）…')

  // 下载：Node.js fetch 在某些平台可能不可用，兜底用系统 curl/PowerShell
  try {
    const res = await fetch(ZIP_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(zipPath, buf)
  } catch {
    // 兜底：PowerShell（Windows）或 curl（类 Unix）
    const cmd = process.platform === 'win32'
      ? `powershell -NoProfile -Command "Invoke-WebRequest -Uri '${ZIP_URL}' -OutFile '${zipPath}'"`
      : `curl -fsSL '${ZIP_URL}' -o '${zipPath}'`
    execSync(cmd, { stdio: 'inherit' })
  }

  // 解压
  console.log('[cyrene] 解压…')
  execSync(`tar -xf "${zipPath.replace(/\\/g, sep)}" -C "${tmp.replace(/\\/g, sep)}"`)

  // 确认源路径
  const srcDir = join(tmp, 'OTF', 'SimplifiedChinese')
  if (!existsSync(srcDir)) {
    throw new Error(`解压后未找到 OTF/SimplifiedChinese 目录`)
  }

  // 创建目标目录
  mkdirSync(FONTS_DIR, { recursive: true })

  // 逐个复制并重命名
  for (const w of WEIGHTS) {
    const src = join(srcDir, w.sc)
    if (!existsSync(src)) {
      throw new Error(`解压包中未找到 ${w.sc}`)
    }
    const dst = join(FONTS_DIR, w.cn)
    copyFileSync(src, dst)
    console.log(`[cyrene] ${w.cn} (${w.weight}) ✓`)
  }

  console.log('[cyrene] 思源黑体下载完成 ✓')
} catch (e) {
  console.error('[cyrene] 字体下载失败：', e.message)
  console.error('[cyrene] 请到项目根目录手动下载：')
  console.error(`        ${ZIP_URL}`)
  console.error('[cyrene] 解压后把 OTF/SimplifiedChinese/ 下的 4 个文件放 public/fonts/，')
  console.error('[cyrene] 并重命名为 SourceHanSansCN-{Regular,Medium,Bold,Heavy}.otf')
  // 不 exit(1)——字体缺失只是无中文显示，不影响构建
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
