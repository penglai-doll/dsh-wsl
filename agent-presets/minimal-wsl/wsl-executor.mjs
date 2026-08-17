/**
 * wsl-executor: WSL bash provider for the `minimal-wsl` agent preset.
 *
 * Why this file exists:
 *  - the shipped `minimal` preset's persistent PTY shell cannot start on
 *    Windows (`@deepseek-ai/dsh-subprocess-local` refuses win32 terminal
 *    inspection), and
 *  - `@deepseek-ai/dsh-bash-local` hardcodes `bash` from PATH, which a
 *    Windows machine does not provide.
 *
 * This plugin replaces `ctx.shell` inside an entry-local realm (see the
 * preset's `wsl-shell` group) and runs every command as
 * `wsl.exe [-d <distro>] [--cd <wsl-workdir>] -- bash -c <command>` through
 * the host subprocess service — a fresh shell per call, with the same `bash`
 * tool name and `str_replace_editor` surface as the original preset. Only
 * Node built-in modules are imported: preset-local files resolve against the
 * preset directory, so DSH package imports would fail.
 *
 * Path model: the file tools read and write Windows paths (D:\...), while
 * commands execute inside WSL where the same location is /mnt/d/....
 * Translation happens in JS (`toWslPath`) because wsl.exe strips backslashes
 * from argv, which breaks `wslpath` round-trips.
 *
 * Environment model: WSL does not inherit the Windows environment, so the
 * entries a command needs are forwarded by name through WSLENV.
 *
 * Sandbox note: the Windows process sandbox cannot confine processes inside
 * the WSL VM, so commands are gated on the danger-full-access policy. The
 * bash tool's single-call `sandbox_permissions: "danger-full-access"`
 * escalation, or switching the session sandbox mode to full access,
 * satisfies the gate.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wsl-executor'

/** Required host services; ordering matters because apply() reads them eagerly. */
export const inject = ['subprocess', 'sandboxPolicy']

/** Node's maximum timer delay before setTimeout clamps to 1ms. */
const MAX_TIMER_DELAY_MS = 2147483647

const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

/**
 * Translate a Windows absolute path into its WSL /mnt form.
 * Returns undefined when no mapping exists (UNC, relative, empty).
 */
export function toWslPath(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const s = value.replace(/\\/g, '/')
  if (s.startsWith('//')) return undefined
  if (s.startsWith('/')) return s
  const m = /^([A-Za-z]):($|\/(.*)$)/.exec(s)
  if (m === null) return undefined
  const drive = m[1].toLowerCase()
  const rest = m[3] ?? ''
  return `/mnt/${drive}${rest === '' ? '' : `/${rest}`}`
}

/** Translate a WSL /mnt path back into its Windows form. Undefined when unmappable. */
export function toWindowsPath(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const s = value.replace(/\\/g, '/')
  const m = /^\/mnt\/([A-Za-z])(?:$|\/(.*)$)/.exec(s)
  if (m === null) return undefined
  const drive = `${m[1].toUpperCase()}:`
  const rest = m[2] ?? ''
  return `${drive}\\${rest.replace(/\//g, '\\')}`
}

function positiveNumber(config, label, fallback) {
  const value = config[label] ?? fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name}: ${label} must be a positive finite number`)
  }
  return value
}

export function resolveConfig(config, env = process.env) {
  const source = config ?? {}
  const distro = typeof source.distro === 'string' && source.distro.trim().length > 0
    ? source.distro.trim()
    : undefined
  const timeoutMs = positiveNumber(source, 'timeoutMs', 120000)
  const maxTimeoutMs = positiveNumber(source, 'maxTimeoutMs', 600000)
  const graceMs = positiveNumber(source, 'graceMs', 3000)
  if (timeoutMs > MAX_TIMER_DELAY_MS || maxTimeoutMs > MAX_TIMER_DELAY_MS || graceMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${name}: timeoutMs, maxTimeoutMs and graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return {
    distro,
    timeoutMs,
    maxTimeoutMs,
    maxOutputBytes: positiveNumber(source, 'maxOutputBytes', 64000),
    maxSpillBytes: positiveNumber(source, 'maxSpillBytes', 64 * 1024 * 1024),
    graceMs,
  }
}

/** Fuse upstream cancellation with an identifiable timeout. */
function timeoutSignal(upstream, timeoutMs) {
  const timer = new AbortController()
  const id = setTimeout(() => {
    timer.abort(new Error('BASH_TIMEOUT'))
  }, timeoutMs)
  const signal = upstream === undefined
    ? timer.signal
    : AbortSignal.any([upstream, timer.signal])
  return {
    signal,
    timedOut: () => timer.signal.aborted,
    dispose: () => clearTimeout(id),
  }
}

/** Project a settled subprocess collector into the tool result shape. */
function finalOutput(reader) {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...(read.spillPath === undefined ? {} : { spillPath: read.spillPath }),
  }
}

/**
 * Merge the env entries a command needs and forward them through WSLENV.
 * The subprocess service merges this map over the scrubbed parent env, so a
 * WSLENV key here replaces the parent's; existing parent entries are
 * preserved by reading them first.
 */
export function forwardEnv(specEnv, dshEnv, parentEnv = process.env) {
  const merged = { ...ENV_OVERRIDES, ...(specEnv ?? {}), ...(dshEnv ?? {}) }
  const names = Object.keys(merged)
  const existing = String(parentEnv.WSLENV ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const wslenv = [...new Set([...existing, ...names])].join(':')
  return { ...merged, WSLENV: wslenv }
}

/** Wrap a spawn failure with the workdir and mapping that caused it. */
function spawnError(workdir, cause) {
  return new Error(`${name}: failed to start wsl.exe (workdir: ${JSON.stringify(workdir)}): ${cause?.message ?? String(cause)}`, {
    cause,
  })
}

/**
 * Build the exact wsl.exe argv for one command. Throws when the Windows
 * workdir cannot be mapped into WSL (UNC or relative path).
 */
export function argvFor(resolved, workdirWin, command) {
  const wslCwd = toWslPath(workdirWin)
  if (wslCwd === undefined) {
    throw new Error(`${name}: cannot map workdir ${JSON.stringify(workdirWin)} to a WSL /mnt path `
      + '(UNC and relative paths are not supported); use an absolute drive-letter path')
  }
  const argv = ['wsl.exe']
  if (resolved.distro !== undefined) argv.push('-d', resolved.distro)
  argv.push('--cd', wslCwd, '--', 'bash', '-c', command)
  return argv
}

/** Read the user's saved distro choice from the settings service. */
export function chosenDistro(configDistro, settings) {
  if (settings === undefined || typeof settings.get !== 'function') return configDistro
  try {
    const value = settings.get('wsl')
    if (value !== undefined && value !== null && typeof value === 'object'
      && typeof value.distro === 'string' && value.distro.trim().length > 0) {
      return value.distro.trim()
    }
  } catch {
    // namespace not registered (preset used without the plugin mounted)
  }
  return configDistro
}

/** Register the WSL bash executor as the entry-local `shell` provider. */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new Error(`${name}: ctx.subprocess is unavailable`)
  }
  const sandboxPolicy = ctx.get('sandboxPolicy')
  // Live distro choice: the settings service (host-chained) wins over config.
  const settings = ctx.get('settings')
  const distroFor = () => chosenDistro(resolved.distro, settings)

  const gateMessage = (mode) =>
    `${name}: commands run inside the WSL VM, which the Windows sandbox cannot confine `
    + `(the current mode is "${mode ?? 'unknown'}"), so running under it would only appear to be restricted. `
    + 'Retry this exact command once with sandbox_permissions: "danger-full-access" plus a justification, '
    + 'or ask the user to switch the session sandbox mode to full access (完全访问).'

  // One-shot warm-up: the first wsl.exe call boots the VM (seconds). Fire
  // once at load, best-effort, and never again.
  let warmedUp = false
  const warmup = () => {
    if (warmedUp) return
    warmedUp = true
    try {
      const argv = ['wsl.exe']
      const distro = distroFor()
      if (distro !== undefined) argv.push('-d', distro)
      argv.push('--', 'true')
      subprocess.spawn({
        argv,
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        graceMs: resolved.graceMs,
      })
    } catch {
      // warm-up is best-effort; the first real command pays the boot cost
    }
  }
  const timer = ctx.get('timer')
  if (timer !== undefined && typeof timer.timeout === 'function') {
    timer.timeout(warmup, 0)
  } else {
    warmup()
  }

  const spawnSpec = (spec, argv, stdoutMaxBytes, signal) => ({
    argv,
    cwd: spec.workdir,
    stdio: {
      stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
      stdout: { maxBytes: stdoutMaxBytes, spill: { maxBytes: resolved.maxSpillBytes } },
      stderr: { maxBytes: resolved.maxOutputBytes, spill: { maxBytes: resolved.maxSpillBytes } },
    },
    graceMs: resolved.graceMs,
    signal,
    env: forwardEnv(spec.env, spec.dshEnv),
  })

  const spawnShell = (spec, stdoutMaxBytes, signal) => {
    const argv = argvFor({ ...resolved, distro: distroFor() }, spec.workdir, spec.command)
    try {
      return subprocess.spawn(spawnSpec(spec, argv, stdoutMaxBytes, signal))
    } catch (error) {
      throw spawnError(spec.workdir, error)
    }
  }

  const executor = {
    /** Advertise confinement so the bash tool offers per-call escalation. */
    get sandboxMode() {
      return sandboxPolicy === undefined ? undefined : sandboxPolicy.defaultMode
    },

    resolve(request) {
      const timeoutMs = Math.min(request.timeoutMs ?? resolved.timeoutMs, resolved.maxTimeoutMs)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`${name}: request.timeoutMs must be a positive finite number`)
      }
      const stdoutMaxBytes = request.stdoutMaxBytes ?? resolved.maxOutputBytes
      if (!Number.isFinite(stdoutMaxBytes) || stdoutMaxBytes <= 0) {
        throw new Error(`${name}: request.stdoutMaxBytes must be a positive finite number`)
      }
      // wsl.exe's stdin relay cannot feed bash's own input buffer: bash
      // caches an EOF at startup and later pipe data never reaches builtins
      // like `read` (verified empirically). Fail loud and offer the shell
      // idiom instead.
      if (request.stdin !== undefined) {
        throw new Error(`${name}: stdin forwarding into WSL bash is not supported (wsl.exe's stdin relay `
          + "cannot reach bash builtins); pass the data with a heredoc inside the command instead, e.g. "
          + "command: \"read x <<'EOF'\" + newline + data lines + newline + \"EOF\"")
      }
      return {
        command: request.command,
        workdir: request.workdir ?? process.cwd(),
        timeoutMs,
        stdoutMaxBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...(request.env === undefined ? {} : { env: request.env }),
        ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
        sandboxPolicy: request.sandboxPolicy ?? (sandboxPolicy?.resolve === undefined ? undefined : sandboxPolicy.resolve()),
      }
    },

    async run(spec) {
      const mode = spec.sandboxPolicy?.mode
      // `undefined` means the deployment carries no sandbox policy at all.
      if (mode !== undefined && mode !== 'danger-full-access') {
        throw new Error(gateMessage(mode))
      }
      const fused = timeoutSignal(spec.signal, spec.timeoutMs)
      try {
        const handle = spawnShell(spec, spec.stdoutMaxBytes, fused.signal)
        let outcome
        try {
          outcome = await handle.done
        } catch (error) {
          throw spawnError(spec.workdir, error)
        }
        const stdout = finalOutput(handle.collected.stdout)
        const stderr = finalOutput(handle.collected.stderr)
        const timedOut = fused.timedOut()
        const aborted = spec.signal !== undefined && spec.signal.aborted && !timedOut
        return {
          ...outcome,
          timedOut,
          aborted,
          timeoutMs: spec.timeoutMs,
          stdout,
          stderr,
          ...(mode === undefined ? {} : { sandbox: { mode, denied: false } }),
        }
      } finally {
        fused.dispose()
      }
    },

    start(spec) {
      const mode = spec.sandboxPolicy?.mode
      if (mode !== undefined && mode !== 'danger-full-access') {
        throw new Error(gateMessage(mode))
      }
      const running = spawnShell(spec, resolved.maxOutputBytes, spec.signal)
      const collected = {
        stdout: running.collected.stdout,
        stderr: running.collected.stderr,
      }
      let spawnFailureNote
      const consumeSpawnFailure = () => {
        const note = spawnFailureNote ?? ''
        spawnFailureNote = undefined
        return note
      }
      let stdoutOffset = 0
      let stderrOffset = 0
      const proc = {
        status: 'running',
        exitCode: null,
        signal: null,
        done: running.done.then((outcome) => {
          if (proc.status === 'running') {
            proc.status = spec.signal?.aborted === true || outcome.signal !== null
              ? 'killed'
              : 'completed'
          }
          proc.exitCode = outcome.exitCode
          proc.signal = outcome.signal
        }, (error) => {
          proc.status = 'killed'
          spawnFailureNote = spawnError(spec.workdir, error).message
        }),
        readOutput: () => {
          const out = collected.stdout.readFrom(stdoutOffset)
          const err = collected.stderr.readFrom(stderrOffset)
          stdoutOffset = out.nextOffset
          stderrOffset = err.nextOffset
          const errText = err.text.length > 0 ? err.text : consumeSpawnFailure()
          const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
          return {
            delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
            lossy: out.lossy || err.lossy,
            ...(out.spillPath === undefined ? {} : { stdoutSpillPath: out.spillPath }),
            ...(err.spillPath === undefined ? {} : { stderrSpillPath: err.spillPath }),
          }
        },
        kill: () => {
          if (proc.status !== 'running') return false
          proc.status = 'killed'
          running.terminate()
          return true
        },
      }
      return proc
    },
  }

  ctx.provide('shell', executor)
}
