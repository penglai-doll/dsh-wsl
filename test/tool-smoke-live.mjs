// Live smoke test for the general-purpose `wsl` tool (host half) against the
// real WSL. Run directly:  node test/tool-smoke-live.mjs
//
// Wires apply() to a child_process-backed stand-in for the subprocess
// service and drives tool.execute with real commands, covering the full
// host-half execution path: workdir resolution, argv/env construction,
// output collection, timeout, and abort semantics.

import { spawn } from 'node:child_process'
import { apply } from '../lib/index.js'

function realSubprocess() {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
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

const registered = []
const ctx = {
  get(name) {
    if (name === 'tools') return { register: (def) => { registered.push(def); return () => {} } }
    if (name === 'subprocess') return realSubprocess()
    if (name === 'sandboxPolicy') return { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access' }) }
    if (name === 'webServer') return { register: () => () => {} }
    return undefined
  },
  effect(fn) { fn(); return () => {} },
}

apply(ctx, { installPreset: false, warmup: false, settingsApi: false })
const tool = registered[0]
const exec = { agent: { session: { header: { cwd: 'D:\\Project\\DSH-Plugins' } } }, signal: undefined }

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

await check('pwd runs at the mapped workspace', async () => {
  const r = await tool.execute({ command: 'pwd', description: 'print cwd', timeoutMs: 30000 }, exec)
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr.text}`)
  if (!r.stdout.text.includes('/mnt/d/Project/DSH-Plugins')) throw new Error(`unexpected pwd: ${JSON.stringify(r.stdout.text)}`)
})

await check('exit codes pass through', async () => {
  const r = await tool.execute({ command: 'exit 9', description: 'exit nine' }, exec)
  if (r.exitCode !== 9) throw new Error(`expected 9, got ${r.exitCode}`)
})

await check('relative workdir resolves against the session cwd', async () => {
  const r = await tool.execute({ command: 'pwd', description: 'print cwd', workdir: 'dsh-wsl' }, exec)
  if (!r.stdout.text.includes('/mnt/d/Project/DSH-Plugins/dsh-wsl')) throw new Error(`unexpected pwd: ${JSON.stringify(r.stdout.text)}`)
})

await check('explicit distro override', async () => {
  const r = await tool.execute({ command: 'uname -s', description: 'kernel name', distro: 'Ubuntu' }, exec)
  if (!r.stdout.text.includes('Linux')) throw new Error(`unexpected uname: ${JSON.stringify(r.stdout.text)}`)
})

await check('timeout kills the command', async () => {
  const r = await tool.execute({ command: 'sleep 30', description: 'sleep long', timeoutMs: 1500 }, exec)
  if (r.timedOut !== true) throw new Error(`expected timedOut, got ${JSON.stringify({ exitCode: r.exitCode, timedOut: r.timedOut })}`)
})

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`)
process.exit(failures === 0 ? 0 : 1)
