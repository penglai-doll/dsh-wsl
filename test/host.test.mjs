// Host-half apply() over mocked services: tool registration, sandbox gating,
// execute flow, route registration, and the settings-backed distro choice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, gateCheck, resolveWorkdir, dshHome, chosenDistro } from '../lib/index.js'

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

function makeCtx({ mode = 'workspace-write', subprocess, savedDistro = '' } = {}) {
  const ctx = {
    registered: { tools: [], routes: [] },
    settingsValue: { distro: savedDistro },
    settingsUpdates: [],
    get(name) {
      if (name === 'terminals') return undefined // host mount
      if (name === 'subprocess') return subprocess ?? { spawn: () => mockHandle() }
      if (name === 'sandboxPolicy') return {
        defaultMode: mode,
        resolve: () => ({ mode }),
      }
      if (name === 'settings') return {
        register: () => {},
        get: () => this.settingsValue,
        update: async (_ns, patch) => {
          this.settingsUpdates.push(patch)
          this.settingsValue = { ...this.settingsValue, ...patch }
        },
      }
      if (name === 'tools') return {
        register: (def) => { this.registered.tools.push(def); return () => {} },
      }
      if (name === 'webServer') return {
        register: (route) => { this.registered.routes.push(route); return () => {} },
      }
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  // make `this` inside get refer to ctx for the registry captures
  ctx.get = ctx.get.bind(ctx)
  return ctx
}

function mockReq(url, method, body) {
  const req = { url, method }
  req.on = (event, cb) => {
    if (event === 'data' && body !== undefined) {
      // readJsonBody consumes chunks on 'data' then parses on 'end'
      const chunks = []
      chunks.push(Buffer.from(body, 'utf8'))
      setImmediate(() => { for (const c of chunks) cb(c) })
      return req
    }
    if (event === 'end') {
      setImmediate(() => cb())
      return req
    }
    if (event === 'error') return req
    return req
  }
  return req
}

function mockRes() {
  const res = { statusCode: 0, headers: {} }
  res.setHeader = (k, v) => { res.headers[k] = v }
  res.end = (payload) => { res.body = payload }
  return res
}

test('apply registers the wsl tool and the /wsl-manager routes', () => {
  const ctx = makeCtx()
  apply(ctx, {})
  assert.equal(ctx.registered.tools.length, 1)
  const tool = ctx.registered.tools[0]
  assert.equal(tool.name, 'wsl')
  assert.ok(tool.description.includes('/mnt/d/dir/file'))
  assert.deepEqual(tool.parameters.required, ['command', 'description'])
  assert.equal(tool.parameters.properties.command.type, 'string')
  assert.equal(ctx.registered.routes.length, 1)
  assert.equal(ctx.registered.routes[0].path, '/wsl-manager')
})

test('wsl tool execute refuses confined modes with guidance', async () => {
  const ctx = makeCtx({ mode: 'workspace-write' })
  apply(ctx, {})
  const tool = ctx.registered.tools[0]
  const exec = { agent: { session: { header: { cwd: 'D:\\Project\\x' } } }, signal: undefined }
  await assert.rejects(() => tool.execute({ command: 'ls', description: 'list' }, exec), /cannot confine/)
})

test('wsl tool execute runs through subprocess under full access', async () => {
  const spawns = []
  const ctx = makeCtx({
    mode: 'danger-full-access',
    subprocess: {
      spawn: (spec) => {
        spawns.push(spec)
        return mockHandle()
      },
    },
  })
  apply(ctx, {})
  const tool = ctx.registered.tools[0]
  const exec = { agent: { session: { header: { cwd: 'D:\\Project\\x' } } }, signal: undefined }
  const result = await tool.execute({ command: 'ls', description: 'list', timeoutMs: 5000 }, exec)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text, 'out\n')
  assert.equal(result.timedOut, false)
  const spec = spawns[spawns.length - 1]
  assert.deepEqual(spec.argv, ['wsl.exe', '--cd', '/mnt/d/Project/x', '--', 'bash', '-c', 'ls'])
  assert.ok(spec.env.WSLENV.length > 0)
})

test('wsl tool execute rejects unmappable workdirs', async () => {
  const ctx = makeCtx({ mode: 'danger-full-access' })
  apply(ctx, {})
  const tool = ctx.registered.tools[0]
  const exec = { agent: { session: { header: { cwd: '\\\\server\\share' } } }, signal: undefined }
  await assert.rejects(() => tool.execute({ command: 'ls', description: 'list' }, exec), /cannot map workdir/)
})

test('gateCheck and resolveWorkdir helpers', () => {
  assert.equal(gateCheck(undefined), null)
  assert.equal(gateCheck('danger-full-access'), null)
  assert.ok(gateCheck('workspace-write').includes('cannot confine'))
  assert.deepEqual(resolveWorkdir('D:\\x', undefined), { windows: 'D:\\x', wsl: '/mnt/d/x' })
  const exec = { agent: { session: { header: { cwd: 'D:\\Project\\y' } } } }
  assert.deepEqual(resolveWorkdir(undefined, exec), { windows: 'D:\\Project\\y', wsl: '/mnt/d/Project/y' })
  // relative workdir resolves against the session cwd
  assert.deepEqual(resolveWorkdir('sub\\dir', exec), { windows: 'D:\\Project\\y\\sub\\dir', wsl: '/mnt/d/Project/y/sub/dir' })
  // POSIX workdir is unmappable for the Windows-side spawn
  assert.deepEqual(resolveWorkdir('/mnt/d/x', exec), { windows: '/mnt/d/x', wsl: undefined })
})

test('dshHome resolves DSH_HOME', () => {
  assert.equal(typeof dshHome(), 'string')
  assert.ok(dshHome().length > 0)
})

test('chosenDistro: settings win, config falls back', () => {
  assert.equal(chosenDistro('Ubuntu', undefined), 'Ubuntu')
  assert.equal(chosenDistro('Ubuntu', { get: () => undefined }), 'Ubuntu')
  assert.equal(chosenDistro('Ubuntu', { get: () => ({ distro: '  archlinux  ' }) }), 'archlinux')
  assert.equal(chosenDistro('Ubuntu', { get: () => ({ distro: '' }) }), 'Ubuntu')
  assert.equal(chosenDistro('Ubuntu', { get: () => { throw new Error('no ns') } }), 'Ubuntu')
  assert.equal(chosenDistro(undefined, { get: () => ({ distro: 'archlinux' }) }), 'archlinux')
})

test('saved distro feeds the wsl tool argv', async () => {
  const spawns = []
  const ctx = makeCtx({
    mode: 'danger-full-access',
    savedDistro: 'archlinux',
    subprocess: { spawn: (spec) => { spawns.push(spec); return mockHandle() } },
  })
  apply(ctx, { distro: 'Ubuntu' })
  const tool = ctx.registered.tools[0]
  const exec = { agent: { session: { header: { cwd: 'D:\\x' } } }, signal: undefined }
  await tool.execute({ command: 'uname', description: 'kernel' }, exec)
  const spec = spawns[spawns.length - 1]
  assert.deepEqual(spec.argv, ['wsl.exe', '-d', 'archlinux', '--cd', '/mnt/d/x', '--', 'bash', '-c', 'uname'])
})

test('POST /wsl-manager/distro persists the choice through settings', async () => {
  const ctx = makeCtx({ savedDistro: 'Ubuntu' })
  apply(ctx, {})
  const route = ctx.registered.routes[0]
  const res = mockRes()
  await route.handler(mockReq('/wsl-manager/distro', 'POST', '{"distro":"archlinux"}'), res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.distro, 'archlinux')
  assert.deepEqual(ctx.settingsUpdates, [{ distro: 'archlinux' }])
})

test('POST /wsl-manager/distro rejects invalid bodies', async () => {
  const ctx = makeCtx()
  apply(ctx, {})
  const route = ctx.registered.routes[0]
  const res = mockRes()
  await route.handler(mockReq('/wsl-manager/distro', 'POST', '{"nope":1}'), res)
  assert.equal(res.statusCode, 400)
  const res2 = mockRes()
  await route.handler(mockReq('/wsl-manager/distro', 'POST', 'not-json'), res2)
  assert.equal(res2.statusCode, 400)
})
