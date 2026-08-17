import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, argvFor, forwardEnv, toWslPath } from '../agent-presets/minimal-wsl/wsl-executor.mjs'

// ---- pure helpers -----------------------------------------------------------

test('resolveConfig defaults and validation', () => {
  const c = resolveConfig({ distro: 'Ubuntu' })
  assert.equal(c.distro, 'Ubuntu')
  assert.equal(c.timeoutMs, 120000)
  assert.equal(c.maxTimeoutMs, 600000)
  assert.equal(c.maxOutputBytes, 64000)
  assert.equal(c.maxSpillBytes, 64 * 1024 * 1024)
  assert.equal(c.graceMs, 3000)
  assert.equal(resolveConfig({}).distro, undefined)
  assert.throws(() => resolveConfig({ timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => resolveConfig({ graceMs: -1 }), /graceMs/)
})

test('argvFor builds the wsl.exe command line', () => {
  assert.deepEqual(
    argvFor({ distro: 'Ubuntu' }, 'D:\\Project\\x y', 'ls -la'),
    ['wsl.exe', '-d', 'Ubuntu', '--cd', '/mnt/d/Project/x y', '--', 'bash', '-c', 'ls -la'],
  )
  assert.deepEqual(
    argvFor({ distro: undefined }, 'C:\\', 'pwd'),
    ['wsl.exe', '--cd', '/mnt/c', '--', 'bash', '-c', 'pwd'],
  )
})

test('argvFor refuses unmappable workdirs', () => {
  assert.throws(() => argvFor({ distro: 'Ubuntu' }, '\\\\server\\share', 'ls'), /cannot map workdir/)
  assert.throws(() => argvFor({ distro: 'Ubuntu' }, 'relative', 'ls'), /cannot map workdir/)
})

test('forwardEnv merges WSLENV', () => {
  const env = forwardEnv({ FOO: '1' }, { DSH_SESSION_ID: 's1' }, { WSLENV: 'EXIST', PATH: 'x' })
  assert.equal(env.FOO, '1')
  assert.equal(env.DSH_SESSION_ID, 's1')
  assert.equal(env.TERM, 'dumb')
  assert.equal(env.WSLENV, 'EXIST:NO_COLOR:TERM:PAGER:GIT_PAGER:FOO:DSH_SESSION_ID')
  const dedup = forwardEnv({ TERM: 'xterm' }, {}, { WSLENV: 'TERM' })
  assert.equal(dedup.TERM, 'xterm')
  assert.equal(dedup.WSLENV, 'TERM:NO_COLOR:PAGER:GIT_PAGER')
})

// ---- executor contract over a mock subprocess -------------------------------

function collector(text) {
  return { readFrom: () => ({ text, lossy: false, nextOffset: text.length }) }
}

function mockHandle(overrides = {}) {
  return {
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: { stdout: collector('out\n'), stderr: collector('') },
    terminate() {},
    ...overrides,
  }
}

function makeCtx(config = {}) {
  const spawns = []
  const ctx = {
    get(name) {
      if (name === 'subprocess') return {
        spawn: (spec) => {
          spawns.push(spec)
          return mockHandle()
        },
      }
      if (name === 'sandboxPolicy') return {
        defaultMode: 'workspace-write',
        resolve: () => ({ mode: 'workspace-write' }),
      }
      if (name === 'timer') return undefined
      return undefined
    },
    provided: null,
    provide(name, value) {
      this.provided = { name, value }
    },
  }
  return { ctx, spawns }
}

// Import apply for the contract tests.
import { apply } from '../agent-presets/minimal-wsl/wsl-executor.mjs'

test('apply provides a shell executor with sandbox gating', async () => {
  const { ctx, spawns } = makeCtx()
  apply(ctx, { distro: 'Ubuntu', timeoutMs: 1000, maxTimeoutMs: 2000, graceMs: 100 })
  const shell = ctx.provided.value
  assert.equal(ctx.provided.name, 'shell')
  assert.equal(shell.sandboxMode, 'workspace-write')

  const spec = shell.resolve({
    command: 'echo hi',
    workdir: 'D:\\Project\\DSH-Plugins',
    timeoutMs: 500,
  })
  assert.equal(spec.workdir, 'D:\\Project\\DSH-Plugins')
  assert.equal(spec.timeoutMs, 500)
  assert.equal(spec.sandboxPolicy.mode, 'workspace-write')

  // gated: workspace-write must be refused with guidance
  await assert.rejects(() => shell.run(spec), /WSL VM, which the Windows sandbox cannot confine/)
  assert.equal(spawns.length, 1) // only the warm-up spawn happened

  // full access runs through the mock subprocess
  const fullSpec = shell.resolve({
    command: 'echo hi',
    workdir: 'D:\\Project\\DSH-Plugins',
    sandboxPolicy: { mode: 'danger-full-access' },
  })
  const result = await shell.run(fullSpec)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text, 'out\n')
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
  const lastSpawn = spawns[spawns.length - 1]
  assert.deepEqual(lastSpawn.argv, ['wsl.exe', '-d', 'Ubuntu', '--cd', '/mnt/d/Project/DSH-Plugins', '--', 'bash', '-c', 'echo hi'])
  assert.equal(lastSpawn.cwd, 'D:\\Project\\DSH-Plugins')
  assert.ok(lastSpawn.env.WSLENV.includes('DSH_SESSION_ID') === false)
})

test('start() returns a live background handle and gates the same way', async () => {
  const { ctx } = makeCtx()
  apply(ctx, { distro: 'Ubuntu' })
  const shell = ctx.provided.value
  const spec = shell.resolve({ command: 'sleep 10', workdir: 'D:\\x' })
  assert.throws(() => shell.start(spec), /cannot confine/)
  const fullSpec = shell.resolve({
    command: 'sleep 10',
    workdir: 'D:\\x',
    sandboxPolicy: { mode: 'danger-full-access' },
  })
  const proc = shell.start(fullSpec)
  assert.equal(proc.status, 'running')
  const read = proc.readOutput()
  assert.equal(read.delta, 'out\n')
  const outcome = await proc.done
  assert.equal(proc.status, 'completed')
  assert.equal(outcome, undefined)
})

test('run() rejects spawn failures with the workdir named', async () => {
  let shell
  const ctx = {
    get(name) {
      if (name === 'subprocess') return {
        spawn: (spec) => {
          if (!spec.argv.includes('bash')) return mockHandle() // warm-up call
          const handle = mockHandle()
          handle.done = Promise.reject(new Error('spawn ENOENT'))
          return handle
        },
      }
      if (name === 'timer') return undefined
      return undefined // no sandboxPolicy: deployment carries none
    },
    provide(_name, value) {
      shell = value
    },
  }
  apply(ctx, {})
  const spec = shell.resolve({ command: 'true', workdir: 'D:\\Project\\x' })
  await assert.rejects(() => shell.run(spec), /failed to start wsl\.exe \(workdir: "D:\\\\Project\\\\x"\).*spawn ENOENT/)
})

test('resolve() rejects stdin requests with heredoc guidance', () => {
  const { ctx } = makeCtx()
  apply(ctx, {})
  const shell = ctx.provided.value
  assert.throws(
    () => shell.resolve({ command: 'read x', workdir: 'D:\\x', stdin: 'hello' }),
    /stdin forwarding into WSL bash is not supported/,
  )
})

test('settings distro choice overrides config at spawn', async () => {
  const spawns = []
  const ctx = {
    get(name) {
      if (name === 'subprocess') return {
        spawn: (spec) => {
          spawns.push(spec)
          return mockHandle()
        },
      }
      if (name === 'sandboxPolicy') return {
        defaultMode: 'danger-full-access',
        resolve: () => ({ mode: 'danger-full-access' }),
      }
      if (name === 'settings') return { get: () => ({ distro: 'archlinux' }) }
      if (name === 'timer') return undefined
      return undefined
    },
    provide(_name, value) {
      this.shell = value
    },
  }
  apply(ctx, { distro: 'Ubuntu' })
  await ctx.shell.run(ctx.shell.resolve({ command: 'uname -s', workdir: 'D:\\x' }))
  const spec = spawns.find((s) => s.argv.includes('bash'))
  assert.deepEqual(spec.argv, ['wsl.exe', '-d', 'archlinux', '--cd', '/mnt/d/x', '--', 'bash', '-c', 'uname -s'])
})

test('toWslPath edge cases', () => {
  assert.equal(toWslPath('D:'), '/mnt/d')
  assert.equal(toWslPath('C:\\Users'), '/mnt/c/Users')
  assert.equal(toWslPath('/already/posix'), '/already/posix')
})
