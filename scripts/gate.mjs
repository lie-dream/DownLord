// 门禁四件套一次跑完(test / typecheck / lint / build),每件只回一行 ✅ 或 ❌ + 失败全文。
// 存在的理由:四件套分四次跑 = 四轮对话 + 四份全量输出常驻上下文;合并后是一轮 + 全绿时约 5 行。
//
// 刻意不 fail-fast:第一件挂了也把剩下三件跑完。否则修完 test 还得再跑一遍才知道 lint 有没有问题,
// 省下的时间会在下一轮全额吐回来。
//
// 判据口径与既有一致:npm test / npm run typecheck(三 project)/ npm run lint(eslint --quiet,0 error)/ npm run build。
// 用法:npm run gate            四件全跑
//       npm run gate -- test lint   只跑点名的
import { spawnSync } from 'node:child_process'

const STEPS = [
  { name: 'test', script: 'test', hint: '单测' },
  { name: 'typecheck', script: 'typecheck', hint: '三 project 类型检查' },
  { name: 'lint', script: 'lint', hint: 'eslint --quiet,判据 0 error' },
  { name: 'build', script: 'build', hint: '主仓 + 扩展构建' }
]

const picked = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const steps = picked.length > 0 ? STEPS.filter((s) => picked.includes(s.name)) : STEPS

if (steps.length === 0) {
  console.error(`未知的门禁项:${picked.join(' ')};可选:${STEPS.map((s) => s.name).join(' / ')}`)
  process.exit(1)
}

// Windows 上跑 npm scripts 必须 shell:true。Node 18.20.2 / 20.12.2 起(CVE-2024-27980 的修复)
// 禁止 shell:false 直接 spawn .cmd / .bat,`spawnSync('npm.cmd', …, {shell:false})` 恒返回 EINVAL。
// shell:true 通常要防参数注入,这里的参数是本文件内写死的常量、没有任何外部输入拼进去,故安全。
const useShell = process.platform === 'win32'

const results = []

for (const step of steps) {
  // 输出被捕获 → 跑的过程中没有任何回显,build 要几十秒。先打一行说明现在卡在哪。
  console.log(`▶ ${step.name}(${step.hint})…`)

  const run = spawnSync('npm', ['run', step.script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: useShell,
    maxBuffer: 64 * 1024 * 1024
  })

  const ok = !run.error && run.status === 0
  results.push({ step, ok, run })
  console.log(ok ? `✅ ${step.name}` : `❌ ${step.name}`)
}

const failed = results.filter((r) => !r.ok)

for (const { step, run } of failed) {
  console.log(`\n${'='.repeat(60)}\n❌ ${step.name} 失败详情\n${'='.repeat(60)}`)
  if (run.error) console.log(String(run.error))
  if (run.stdout) console.log(run.stdout)
  if (run.stderr) console.log(run.stderr)
}

console.log(
  failed.length === 0
    ? `\n✅ 门禁全绿(${results.map((r) => r.step.name).join(' / ')})`
    : `\n❌ 门禁未过:${failed.map((r) => r.step.name).join(' / ')}(共 ${failed.length}/${results.length} 项)`
)

process.exit(failed.length === 0 ? 0 : 1)
