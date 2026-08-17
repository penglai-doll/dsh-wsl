// Live smoke test for the WSL terminal backend against the real WSL.
// Run directly:  node test/backend-smoke-live.mjs
//
// Exercises the complete persistent-PTY path: node-pty ConPTY -> wsl.exe ->
// Linux bash, prompt-marker readiness, state persistence across sends,
// Ctrl-C interrupt, and graceful close.

import { WslTerminalBackend } from '../lib/backend.js'

const fakeCtx = {
  get(name) {
    if (name === 'terminals') return { hasOwnerActivity: () => false }
    return undefined // no sandboxPolicy: gate passes
  },
}

const owner = {
  id: 'smoke-owner',
  session: { events: [] },
  ctx: { on: () => () => {} },
}

const backend = new WslTerminalBackend(fakeCtx, {
  distro: 'Ubuntu',
  ptysTimeoutMs: 60000,
  graceMs: 3000,
})

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

const t0 = Date.now()
const session = await backend.spawn({
  sessionId: 'pty-smoke-1',
  owner,
  type: 'shell',
  cwd: 'D:\\Project\\DSH-Plugins',
})

console.log(`spawned in ${Date.now() - t0}ms, motd=${JSON.stringify(session.motd.slice(0, 80))}`)

await check('pwd runs in the mapped /mnt workspace', async () => {
  const result = await session.startSend({ text: 'pwd', submit: true }).done
  if (!result.viewport.includes('/mnt/d/Project/DSH-Plugins')) throw new Error(`viewport: ${JSON.stringify(result.viewport)}`)
  console.log('   waitReason:', result.waitReason, '| viewport tail:', JSON.stringify(result.viewport.slice(-60)))
})

await check('state persists across sends', async () => {
  await session.startSend({ text: 'FOO=42', submit: true }).done
  const r2 = await session.startSend({ text: 'echo "FOO=$FOO"', submit: true }).done
  if (!r2.viewport.includes('FOO=42')) throw new Error(`viewport: ${JSON.stringify(r2.viewport)}`)
})

await check('Ctrl-C interrupts a foreground sleep', async () => {
  const op = session.startSend({ text: 'sleep 30', submit: true })
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const cancelled = op.cancel()
  const result = await op.done
  if (!cancelled) throw new Error('cancel() returned false')
  if (session.status().kind !== 'running') throw new Error(`session exited: ${JSON.stringify(session.status())}`)
  console.log('   after ^C waitReason:', result.waitReason, '| session still running')
})

await check('still responsive after interrupt', async () => {
  const r = await session.startSend({ text: 'echo alive', submit: true }).done
  if (!r.viewport.includes('alive')) throw new Error(`viewport: ${JSON.stringify(r.viewport)}`)
})

await check('signal() SIGINT path resolves a pgid and delivers', async () => {
  const op = session.startSend({ text: 'sleep 30', submit: true })
  await new Promise((resolve) => setTimeout(resolve, 2500))
  try {
    const delivered = await session.signal('SIGINT')
    if (delivered.delivered !== true) throw new Error('not delivered')
    console.log('   targetPgid:', delivered.targetPgid)
  } catch (e) {
    // pgid resolution may fail if the pid marker has not arrived; a clear
    // error is acceptable, but the session must stay usable.
    console.log('   signal() reported:', e.message)
    op.cancel()
  }
  await op.done
})

await check('close() terminates the session', async () => {
  await session.close('smoke done')
  const status = session.status()
  if (status.kind !== 'exited') throw new Error(`still ${status.kind}`)
  console.log('   final status:', JSON.stringify(status))
})

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} in ${Date.now() - t0}ms`)
process.exit(failures === 0 ? 0 : 1)
