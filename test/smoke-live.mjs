// Live smoke test for wsl-executor against the real WSL on this machine.
// Not part of `node --test`; run directly:  node test/smoke-live.mjs
//
// It wires the executor's run() path to a minimal child_process-backed
// stand-in for the subprocess service (collect-mode streams), exercising
// argv construction, --cd, WSLENV forwarding, output collection and exit
// codes against the real distro.

import { spawn } from 'node:child_process'
import { apply } from '../agent-presets/minimal-wsl/wsl-executor.mjs'

function realSubprocess() {
  return {
    spawn(spec) {
      const stdinMode = spec.stdio.stdin
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: [stdinMode === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      if (stdinMode !== 'ignore' && child.stdin !== null) {
        child.stdin.on('error', () => {})
        child.stdin.end(stdinMode?.data ?? '')
      }
      const collect = (stream) => {
        const chunks = []
        stream.on('data', (c) => chunks.push(c))
        return {
          readFrom: () => ({
            text: Buffer.concat(chunks).toString('utf8'),
            lossy: false,
            nextOffset: 0,
          }),
        }
      }
      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      return { done, collected: { stdout: collect(child.stdout), stderr: collect(child.stderr) }, terminate: () => child.kill() }
    },
  }
}

let shell
const ctx = {
  get(name) {
    if (name === 'subprocess') return realSubprocess()
    if (name === 'timer') return undefined
    return undefined
  },
  provide(_n, v) { shell = v },
}

apply(ctx, { distro: 'Ubuntu', timeoutMs: 30000, maxTimeoutMs: 30000, graceMs: 1000 })

const t0 = Date.now()
let failures = 0
async function check(label, fn) {
  try {
    await fn()
    console.log('PASS', label)
  } catch (e) {
    failures += 1
    console.log('FAIL', label, '->', e?.message ?? e)
  }
}

await check('pwd maps to /mnt workspace', async () => {
  const r = await shell.run(shell.resolve({ command: 'pwd', workdir: 'D:\\Project\\DSH-Plugins' }))
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr.text}`)
  if (!r.stdout.text.includes('/mnt/d/Project/DSH-Plugins')) throw new Error(`unexpected pwd: ${JSON.stringify(r.stdout.text)}`)
})

await check('WSLENV forwards DSH_* env', async () => {
  const r = await shell.run(shell.resolve({
    command: 'echo "VAR=$DSH_SMOKE_VAR"',
    workdir: 'D:\\Project\\DSH-Plugins',
    dshEnv: { DSH_SMOKE_VAR: 'smoke-42' },
  }))
  if (!r.stdout.text.includes('VAR=smoke-42')) throw new Error(`env not forwarded: ${JSON.stringify(r.stdout.text)}`)
})

await check('exit code passthrough', async () => {
  const r = await shell.run(shell.resolve({ command: 'exit 7', workdir: 'D:\\Project\\DSH-Plugins' }))
  if (r.exitCode !== 7) throw new Error(`expected 7, got ${r.exitCode}`)
})

await check('stdin requests are refused with heredoc guidance', async () => {
  let threw = null
  try {
    shell.resolve({ command: 'read x', workdir: 'D:\\Project\\DSH-Plugins', stdin: 'hello' })
  } catch (e) {
    threw = e
  }
  if (threw === null) throw new Error('expected stdin rejection')
  if (!/stdin forwarding into WSL bash is not supported/.test(threw.message)) throw new Error(`unexpected message: ${threw.message}`)
})

await check('timeout kills the command', async () => {
  const r = await shell.run(shell.resolve({ command: 'sleep 30', workdir: 'D:\\Project\\DSH-Plugins', timeoutMs: 1500 }))
  if (!r.timedOut) throw new Error(`expected timedOut, got ${JSON.stringify({ exitCode: r.exitCode, timedOut: r.timedOut })}`)
})

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} in ${Date.now() - t0}ms`)
process.exit(failures === 0 ? 0 : 1)
