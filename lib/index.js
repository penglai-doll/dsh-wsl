// dsh-wsl — Host half.
//
// A formal (composition-mounted) plugin that brings WSL execution to DeepSeek
// Harness on Windows. Mounted at host level (web profile) it:
//   - installs the `minimal-wsl` agent preset into the user preset root
//     (<dshHome>/.agent-presets/minimal-wsl/, idempotent, `force` to refresh),
//   - registers the general-purpose `wsl` model tool for standard/cordis
//     presets (execute one command inside WSL from a Windows session),
//   - warms the default distro so the first real command skips the VM boot,
//   - serves /wsl-manager/* JSON routes for the client settings tab.
// Mounted inside the minimal-wsl preset's `persistent-shell` group it instead
// registers its terminal backend into that realm's isolated `terminals`
// registry (see lib/backend.js) and nothing else; the preset row disables the
// host-level roles through config flags.
//
// Sandbox trust model: processes inside the WSL VM are outside the Windows
// restricted-token sandbox and can reach every Windows file through /mnt/*,
// so both the `wsl` tool and the terminal backend only run under the
// danger-full-access policy — anything narrower would only appear to confine.
//
// The tool's args/result shapes are plain JSON; the tool never holds Host
// objects across calls.

import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { listDistros, defaultDistro, warmupDistro, wslenvFor } from './wsl.js'
import { toWslPath, isWindowsAbsolute } from './path.js'

export const name = 'wsl'

// Hard dependencies: without the inject list the row activates before these
// services exist and the host roles get silently skipped (the loader
// activates inject-less rows first). The preset-realm mount chains all three
// from the host composition, so both mounts stay satisfiable.
export const inject = ['webServer', 'tools', 'subprocess']

const TOOL_NAME = 'wsl'
const SETTINGS_NS = 'wsl'

function errText(e) {
  if (e == null) return 'unknown error'
  if (typeof e === 'object' && e.message != null) return String(e.message)
  return String(e)
}

export function dshHome() {
  const v = process.env.DSH_HOME
  return v && v.trim() ? v.trim() : join(homedir(), '.dsh')
}

const PRESET_FILES = ['agent.cordis.yml', 'preset.yml', 'wsl-executor.mjs']

/**
 * Install the bundled minimal-wsl preset into the user preset root.
 * Idempotent: an existing target is left alone unless `force` is set.
 */
export async function installPreset(packageRoot, targetRoot, force = false) {
  const source = join(packageRoot, 'agent-presets', 'minimal-wsl')
  const target = join(targetRoot, 'minimal-wsl')
  const files = []
  let existed = false
  try {
    await access(join(target, 'agent.cordis.yml'))
    existed = true
  } catch {
    existed = false
  }
  if (existed && !force) {
    return { path: target, installed: false, fresh: false, files: [], note: 'preset already installed; set force: true to refresh from the package' }
  }
  await mkdir(target, { recursive: true })
  const written = []
  for (const file of PRESET_FILES) {
    await copyFile(join(source, file), join(target, file))
    written.push(file)
  }
  return { path: target, installed: true, fresh: !existed, files: written, note: null }
}

/** Sandbox gate shared by the tool and the terminal backend. */
export function gateCheck(mode) {
  if (mode === undefined || mode === 'danger-full-access') return null
  return `dsh-wsl: commands run inside the WSL VM, which the Windows sandbox cannot confine `
    + `(the current mode is "${mode}"), so running under it would only appear to be restricted. `
    + 'Switch the session sandbox mode to full access (完全访问), or retry a single command through '
    + 'the bash tool of the minimal-wsl preset with sandbox_permissions: "danger-full-access".'
}

/** Resolve the session-relative Windows workdir and its WSL form. */
export function resolveWorkdir(argsWorkdir, exec) {
  const sessionCwd = exec?.agent?.session?.header?.cwd
  const base = argsWorkdir ?? (typeof sessionCwd === 'string' && sessionCwd.length > 0 ? sessionCwd : process.cwd())
  // A relative workdir resolves against the session workspace (bash-tool
  // semantics); absolute Windows forms pass through. POSIX paths are not a
  // valid Windows workdir for the wsl.exe spawn and surface as unmappable.
  const windows = !isWindowsAbsolute(base) && !isPosixPath(base)
    && typeof sessionCwd === 'string' && sessionCwd.length > 0
    ? resolve(sessionCwd, base)
    : base
  if (isPosixPath(windows)) return { windows, wsl: undefined }
  return { windows, wsl: toWslPath(windows) }
}

function isPosixPath(value) {
  return typeof value === 'string' && value.startsWith('/')
}

function toolDescription() {
  return 'Execute one command inside WSL (Windows Subsystem for Linux) on this Windows machine and return its stdout/stderr. '
    + 'Each call is a fresh shell: no state persists between calls. File tools use Windows paths (D:\\dir\\file); '
    + 'commands must use the WSL form of the same location (/mnt/d/dir/file, lowercase drive letter under /mnt). '
    + 'Non-zero exits are reported as [exit code: N]. Commands run with full access inside the WSL VM: the session '
    + 'needs full access (完全访问) sandbox mode; when the current mode is narrower the call is refused with guidance.'
}

/** Read the user's saved distro choice from the settings service. */
export function chosenDistro(configDistro, settings) {
  if (settings === undefined || typeof settings.get !== 'function') return configDistro
  try {
    const value = settings.get(SETTINGS_NS)
    if (value !== undefined && value !== null && typeof value === 'object'
      && typeof value.distro === 'string' && value.distro.trim().length > 0) {
      return value.distro.trim()
    }
  } catch {
    // namespace not registered (preset used without the plugin mounted)
  }
  return configDistro
}

export function apply(ctx, config = {}) {
  if (process.platform !== 'win32') return // Windows-only capability; inert elsewhere

  const cfg = {
    distro: typeof config.distro === 'string' && config.distro.length > 0 ? config.distro : undefined,
    installPreset: config.installPreset !== false,
    force: config.force === true,
    registerWslTool: config.registerWslTool !== false,
    warmup: config.warmup !== false,
    settingsApi: config.settingsApi !== false,
    // Explicit opt-in: the preset's persistent-shell row sets this; the host
    // row never registers a backend into a host-level terminals registry.
    terminalBackend: config.terminalBackend === true,
    timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 120000,
    maxTimeoutMs: Number.isFinite(config.maxTimeoutMs) && config.maxTimeoutMs > 0 ? config.maxTimeoutMs : 600000,
    maxOutputBytes: Number.isFinite(config.maxOutputBytes) && config.maxOutputBytes > 0 ? config.maxOutputBytes : 64000,
    graceMs: Number.isFinite(config.graceMs) && config.graceMs > 0 ? config.graceMs : 3000,
  }

  const subprocess = ctx.get('subprocess')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const webServer = ctx.get('webServer')
  const tools = ctx.get('tools')
  const shellEnv = ctx.get('shellEnv')

  // ---- user-saved distro choice (settings service) ---------------------------
  const settings = ctx.get('settings')
  if (settings !== undefined) {
    try {
      settings.register(SETTINGS_NS, z.object({ distro: z.string().default('') }))
    } catch {
      // already registered by an earlier mount of this package
    }
  }
  const effectiveDistro = () => chosenDistro(cfg.distro, settings)

  // ---- role: preset installer -------------------------------------------------
  if (cfg.installPreset) {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
    const root = dshHome()
    installPreset(packageRoot, join(root, '.agent-presets'))
      .then((result) => {
        if (result.installed) console.log(`dsh-wsl: preset installed at ${result.path}`)
        else if (result.note !== null) console.log(`dsh-wsl: ${result.note} (${result.path})`)
      })
      .catch((e) => console.error('dsh-wsl: preset installation failed: %s', errText(e)))
  }

  // ---- role: distro warm-up ---------------------------------------------------
  if (cfg.warmup) {
    setTimeout(() => warmupDistro(effectiveDistro()), 1000)
  }

  // ---- role: general-purpose wsl tool ----------------------------------------
  if (cfg.registerWslTool && tools !== undefined && subprocess !== undefined) {
    ctx.effect(() => tools.register(defineTool({
      name: TOOL_NAME,
      description: toolDescription(),
      parameters: {
        command: {
          type: 'string',
          required: true,
          description: 'The bash command to execute inside WSL.',
        },
        description: {
          type: 'string',
          required: true,
          description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds (default ${cfg.timeoutMs}, max ${cfg.maxTimeoutMs}).`,
        },
        workdir: {
          type: 'string',
          description: 'Working directory as a Windows path; defaults to the session workspace, and a relative path resolves against it. The command runs at its /mnt mapping.',
        },
        distro: {
          type: 'string',
          description: 'WSL distro name; defaults to the configured/default distro.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
            timedOut: { type: 'boolean', required: true },
            timeoutMs: { type: 'number', required: true },
            stdout: {
              type: 'object', required: true, additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                truncated: { type: 'boolean', required: true },
              },
            },
            stderr: {
              type: 'object', required: true, additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                truncated: { type: 'boolean', required: true },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value === undefined || value === null
            ? ''
            : (() => {
              const markers = []
              if (value.timedOut === true) markers.push(`[timed out after ${value.timeoutMs}ms]`)
              if (value.exitCode !== null && value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`)
              let body = String(value.stdout?.text ?? '')
              if (value.stderr?.text) {
                if (body.length > 0 && !body.endsWith('\n')) body += '\n'
                body += `[stderr]\n${value.stderr.text}`
              }
              if (body.length === 0) body = '(no output)'
              if (markers.length > 0) {
                if (!body.endsWith('\n')) body += '\n'
                body += markers.join('\n')
              }
              return body
            })(),
        }],
      },
      async execute(args, exec) {
        const command = String(args.command ?? '')
        if (command.trim().length === 0) throw new Error('wsl: command must be a non-empty string')
        const timeoutMs = Math.min(
          Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : cfg.timeoutMs,
          cfg.maxTimeoutMs,
        )

        const mode = sandboxPolicy?.resolve !== undefined
          ? (sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })?.mode)
          : undefined
        const gate = gateCheck(mode)
        if (gate !== null) throw new Error(gate)

        const distro = typeof args.distro === 'string' && args.distro.length > 0 ? args.distro : effectiveDistro()
        const { windows, wsl } = resolveWorkdir(args.workdir, exec)
        if (wsl === undefined) {
          throw new Error(`wsl: cannot map workdir ${JSON.stringify(windows)} to a WSL /mnt path (UNC and relative paths are not supported)`)
        }

        const dshEnv = shellEnv === undefined ? {} : (shellEnv.collect(exec) ?? {})
        const argv = ['wsl.exe']
        if (distro !== undefined) argv.push('-d', distro)
        argv.push('--cd', wsl, '--', 'bash', '-c', command)

        const timer = new AbortController()
        const timeoutId = setTimeout(() => timer.abort(new Error('WSL_TIMEOUT')), timeoutMs)
        const signal = exec.signal === undefined ? timer.signal : AbortSignal.any([exec.signal, timer.signal])
        let handle
        try {
          handle = subprocess.spawn({
            argv,
            cwd: windows,
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: cfg.maxOutputBytes, spill: { maxBytes: 64 * 1024 * 1024 } },
              stderr: { maxBytes: cfg.maxOutputBytes, spill: { maxBytes: 64 * 1024 * 1024 } },
            },
            graceMs: cfg.graceMs,
            signal,
            env: {
              NO_COLOR: '1',
              TERM: 'dumb',
              PAGER: 'cat',
              GIT_PAGER: 'cat',
              ...dshEnv,
              WSLENV: wslenvFor(process.env.WSLENV, ['NO_COLOR', 'TERM', 'PAGER', 'GIT_PAGER', ...Object.keys(dshEnv)]),
            },
          })
          const outcome = await handle.done
          const timedOut = timer.signal.aborted
          const aborted = exec.signal !== undefined && exec.signal.aborted && !timedOut
          if (aborted) {
            const error = new Error('tool call aborted')
            error.name = 'AbortError'
            throw error
          }
          const project = (reader) => {
            const read = reader.readFrom(0)
            return { text: read.text, truncated: read.lossy }
          }
          return {
            exitCode: outcome.exitCode,
            timedOut,
            timeoutMs,
            stdout: project(handle.collected.stdout),
            stderr: project(handle.collected.stderr),
          }
        } catch (e) {
          const isAbort = e != null && (e.name === 'AbortError' || (exec.signal !== undefined && exec.signal.aborted))
          if (!isAbort && handle !== undefined) handle.terminate()
          throw e
        } finally {
          clearTimeout(timeoutId)
        }
      },
      presentCall: (args) => ({
        card: 'terminal',
        title: args.command,
        description: args.description,
        ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
      }),
      presentResult: (args, result) => {
        if (result === undefined || result === null) return undefined
        const body = result.stdout?.text ?? ''
        return { card: 'terminal', output: body }
      },
    })), 'dsh-wsl: wsl tool')
  }

  // ---- role: /wsl-manager JSON API -------------------------------------------
  if (cfg.settingsApi && webServer !== undefined) {
    const sendJson = (res, status, payload) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(payload))
    }
    const readJsonBody = (req) => new Promise((resolvePromise) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        try {
          resolvePromise(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          resolvePromise(null)
        }
      })
      req.on('error', () => resolvePromise(null))
    })
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/wsl-manager',
      handler: async (req, res) => {
        const pathname = (req.url ?? '/').split('?')[0]
        const method = req.method ?? 'GET'
        try {
          if (pathname === '/wsl-manager/status' && method === 'GET') {
            const listing = listDistros()
            const presetRoot = join(dshHome(), '.agent-presets', 'minimal-wsl')
            let presetInstalled = false
            try {
              await access(join(presetRoot, 'agent.cordis.yml'))
              presetInstalled = true
            } catch {
              presetInstalled = false
            }
            return sendJson(res, 200, {
              platform: process.platform,
              win32: process.platform === 'win32',
              available: listing.available,
              distros: listing.distros,
              defaultDistro: listing.available ? defaultDistro(listing.distros) : null,
              error: listing.error,
              preset: { path: presetRoot, installed: presetInstalled },
              savedDistro: effectiveDistro() ?? null,
              config: {
                distro: cfg.distro ?? null,
                registerWslTool: cfg.registerWslTool,
                terminalBackend: cfg.terminalBackend,
              },
            })
          }
          if (pathname === '/wsl-manager/warmup' && method === 'POST') {
            const started = warmupDistro(effectiveDistro())
            return sendJson(res, started ? 200 : 500, { ok: started })
          }
          if (pathname === '/wsl-manager/distro' && method === 'POST') {
            if (settings === undefined) {
              return sendJson(res, 500, { ok: false, error: 'settings service unavailable' })
            }
            const body = await readJsonBody(req)
            if (body === null || typeof body.distro !== 'string') {
              return sendJson(res, 400, { ok: false, error: 'body must be { distro: string }' })
            }
            const next = body.distro.trim()
            await settings.update(SETTINGS_NS, { distro: next })
            return sendJson(res, 200, { ok: true, distro: effectiveDistro() ?? null })
          }
          return sendJson(res, 404, { ok: false, error: `unknown /wsl-manager route: ${method} ${pathname}` })
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: errText(e) })
        }
      },
    }), 'dsh-wsl: /wsl-manager routes')
  }

  // ---- role: terminal backend (preset realm mount) ---------------------------
  // Implemented by lib/backend.js; registered once the realm's `terminals`
  // registry appears. The retry loop covers loader ordering: the group's pty
  // row normally activates first, but the interval makes that robust.
  if (cfg.terminalBackend) {
    ctx.effect(() => {
      let registered = false
      let cancelled = false
      const attempt = () => {
        if (cancelled || registered) return
        const t = ctx.get('terminals')
        if (t === undefined) return
        registered = true
        import('./backend.js')
          .then(({ registerWslBackend }) => {
            if (!cancelled) registerWslBackend(ctx, cfg)
          })
          .catch((e) => console.error('dsh-wsl: terminal backend unavailable: %s', errText(e)))
      }
      attempt()
      const id = setInterval(attempt, 250)
      const giveUp = setTimeout(() => {
        if (!registered) console.error('dsh-wsl: terminals service never appeared; persistent PTY backend not registered')
      }, 30000)
      giveUp.unref?.()
      return () => {
        cancelled = true
        clearInterval(id)
        clearTimeout(giveUp)
      }
    }, 'dsh-wsl: WSL terminal backend registration')
  }
}
