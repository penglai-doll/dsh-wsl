// dsh-wsl — WSL terminal backend for the `terminals` registry.
//
// The shipped PTY path (`dsh-terminal-bash` -> `subprocess.spawnTerminal`)
// cannot run on win32: `dsh-subprocess-local` refuses terminal inspection on
// Windows. This backend replaces it for the minimal-wsl preset: node-pty
// allocates a ConPTY on the Windows side, wsl.exe runs inside it and gives
// the Linux bash a real PTY, so interactive programs, Ctrl-C and job control
// behave natively (the same mechanism Windows Terminal uses).
//
// Readiness detection: instead of /proc process inspection (the Linux side
// is a VM; the host cannot read its /proc), each command completion is
// detected by the bash prompt marker — PROMPT_COMMAND prints OSC 133;D, and
// a private OSC 777;pid;$$ announces the Linux bash pid — with idle-silence
// inference and a timeout as fallbacks. Signals resolve the foreground
// process group through a wsl.exe side-call that reads /proc/<pid>/stat.
//
// Session/sanitizer machinery adapts @deepseek-ai/dsh-terminal-bash
// (LocalPtySession/TerminalSanitizer, MIT).

import { TerminalBackendCleanupError, TerminalError } from '@deepseek-ai/dsh-terminal'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { wslenvFor } from './wsl.js'
import { gateCheck } from './index.js'

/**
 * Resolve node-pty. The plugin package is linked into the profile workspace,
 * so its own real path has no node_modules chain; fall back to the profile
 * workspace's hoisted store (deterministic from DSH_HOME).
 */
async function loadNodePty() {
  const attempts = []
  try {
    const mod = await import('node-pty')
    return mod.default ?? mod
  } catch (e) {
    attempts.push(`plugin path: ${e?.message ?? String(e)}`)
  }
  const home = process.env.DSH_HOME
  const roots = []
  if (home !== undefined && home.length > 0) {
    roots.push(join(home, 'profiles', 'node_modules'))
    roots.push(join(home, 'profiles', 'web', 'node_modules'))
  }
  for (const root of roots) {
    try {
      const require = createRequire(join(root, 'noop.cjs'))
      return require('node-pty')
    } catch (e) {
      attempts.push(`${root}: ${e?.message ?? String(e)}`)
    }
  }
  throw new Error(`dsh-wsl: node-pty is not resolvable (tried: ${attempts.join(' | ')}); `
    + 'the persistent PTY shell cannot start. The non-persistent bash tool keeps working. '
    + 'Install node-pty into the profile workspace node_modules.')
}

/** Backend type matched by dsh-tool-bash-persistent's default. */
export const BACKEND_TYPE = 'shell'

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

/** Exact printable prompt emitted after the private marker. */
const CONTROLLED_PROMPT = 'dsh> '

/** Child environment forwarded through WSLENV into the Linux bash. */
function childEnvironment(spec) {
  return {
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    // bash ignores an environment PS1 in this setup, so PROMPT_COMMAND sets
    // it itself. The pid OSC comes FIRST so the prompt marker (133;D) is the
    // last control sequence before the PS1 text: the readiness loop then sees
    // exactly "dsh> " as the marker tail.
    PROMPT_COMMAND: 'PS1="' + CONTROLLED_PROMPT + '"; printf "\\033]777;pid;$$\\007"; printf "\\033]133;D;%s\\007" "$?"',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    DSH_SHELL: '1',
    DSH_SESSION_ID: String(spec.owner.id),
    DSH_PTY_SESSION_ID: String(spec.sessionId),
  }
}

// ---- TerminalSanitizer (adapted from dsh-terminal-bash) ----------------------
function normalizeTerminalText(text) {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\x07', '')
}

export class TerminalSanitizer {
  constructor(maxPendingBytes) {
    this.maxPendingBytes = maxPendingBytes
    this.pending = ''
    this.discardMode = undefined
    this.discardOscEscape = false
    this.trailingCarriageReturn = false
    this.trackingPromptTail = false
    this.pidCapture = undefined
  }

  push(chunk) {
    // An OSC body whose ESC was lost (split or artifact) must not leak its
    // payload into the viewport; consume it through its terminator, or keep
    // discarding until one arrives.
    if (this.pending.length > 0 && this.pending[0] === ']' && this.pending.indexOf('\x1B') < 0) {
      this.pending = ''
    }
    let src = chunk
    if (this.pending.length === 0 && this.discardMode === undefined && typeof src === 'string' && src.startsWith(']')) {
      const bel = src.indexOf('\x07')
      const st = src.indexOf('\x1B\\')
      let end = -1
      if (bel >= 0 && st >= 0) end = Math.min(bel + 1, st + 2)
      else if (bel >= 0) end = bel + 1
      else if (st >= 0) end = st + 2
      if (end < 0) {
        this.discardMode = 'osc'
        this.pending = ''
        return { text: '', prompt: false }
      }
      src = src.slice(end)
    }
    this.pending += this.discardPrefix(src)
    let text = ''
    let prompt = false
    let includePromptTail = this.trackingPromptTail
    let promptTail = ''
    let index = 0
    const appendText = (value) => {
      text += value
      if (this.trackingPromptTail) promptTail += value
    }
    while (index < this.pending.length) {
      const escape = this.pending.indexOf('\x1B', index)
      if (escape < 0) {
        appendText(this.pending.slice(index))
        index = this.pending.length
        break
      }
      appendText(this.pending.slice(index, escape))
      if (escape + 1 >= this.pending.length) {
        index = escape
        break
      }
      const kind = this.pending[escape + 1]
      if (kind === ']') {
        const bel = this.pending.indexOf('\x07', escape + 2)
        const stringTerminator = this.pending.indexOf('\x1B\\', escape + 2)
        let end = -1
        if (bel >= 0 && stringTerminator >= 0) end = Math.min(bel + 1, stringTerminator + 2)
        else if (bel >= 0) end = bel + 1
        else if (stringTerminator >= 0) end = stringTerminator + 2
        if (end < 0) {
          index = escape
          break
        }
        const terminatorBytes = this.pending[end - 1] === '\x07' ? 1 : 2
        const payload = this.pending.slice(escape + 2, end - terminatorBytes)
        if (payload.startsWith('133;D;')) {
          prompt = true
          this.trackingPromptTail = true
          includePromptTail = true
          promptTail = ''
        } else if (payload.startsWith('777;pid;')) {
          const pid = Number(payload.slice('777;pid;'.length))
          if (Number.isSafeInteger(pid) && pid > 0) this.pidCapture = pid
        }
        index = end
        continue
      }
      if (kind === '[') {
        let end = escape + 2
        while (end < this.pending.length) {
          const code = this.pending.charCodeAt(end)
          if (code >= 64 && code <= 126) break
          end += 1
        }
        if (end >= this.pending.length) {
          index = escape
          break
        }
        index = end + 1
        continue
      }
      index = escape + 2
    }
    this.pending = this.pending.slice(index)
    this.enforcePendingBound()
    return {
      text: this.normalizeText(text),
      prompt,
      ...(includePromptTail ? { promptTail } : {}),
    }
  }

  flush() {
    const text = this.pending.startsWith('\x1B') ? '' : this.pending
    this.pending = ''
    this.discardMode = undefined
    this.discardOscEscape = false
    this.trackingPromptTail = false
    const normalized = this.normalizeText(text)
    if (!this.trailingCarriageReturn) return normalized
    this.trailingCarriageReturn = false
    return `${normalized}\n`
  }

  normalizeText(text) {
    let complete = this.trailingCarriageReturn ? `\r${text}` : text
    this.trailingCarriageReturn = false
    if (complete.endsWith('\r')) {
      complete = complete.slice(0, -1)
      this.trailingCarriageReturn = true
    }
    return normalizeTerminalText(complete)
  }

  enforcePendingBound() {
    if (Buffer.byteLength(this.pending) <= this.maxPendingBytes) return
    this.discardMode = this.pending[1] === ']' ? 'osc' : 'csi'
    this.pending = ''
  }

  discardPrefix(chunk) {
    if (this.discardMode === undefined) return chunk
    if (this.discardMode === 'csi') {
      for (let index = 0; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index)
        if (code >= 64 && code <= 126) {
          this.discardMode = undefined
          return chunk.slice(index + 1)
        }
      }
      return ''
    }
    let index = 0
    if (this.discardOscEscape) {
      this.discardOscEscape = false
      if (chunk.startsWith('\\')) {
        this.discardMode = undefined
        return chunk.slice(1)
      }
    }
    while (index < chunk.length) {
      if (chunk[index] === '\x07') {
        this.discardMode = undefined
        return chunk.slice(index + 1)
      }
      if (chunk[index] === '\x1B') {
        if (chunk[index + 1] === '\\') {
          this.discardMode = undefined
          return chunk.slice(index + 2)
        }
        if (index + 1 === chunk.length) this.discardOscEscape = true
      }
      index += 1
    }
    return ''
  }
}

// ---- BoundedTextBuffer (adapted from dsh-terminal-bash) ----------------------
function utf8Tail(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1])
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

class BoundedTextBuffer {
  constructor(maxBytes, maxLines) {
    this.maxBytes = maxBytes
    this.maxLines = maxLines
    this.value = ''
    this.dropped = false
  }

  append(text) {
    if (text.length === 0) return
    this.value += text
    if (this.maxLines !== undefined) {
      const lines = this.value.split('\n')
      if (lines.length > this.maxLines) {
        this.value = lines.slice(lines.length - this.maxLines).join('\n')
        this.dropped = true
      }
    }
    const tail = utf8Tail(this.value, this.maxBytes)
    this.value = tail.text
    this.dropped ||= tail.truncated
  }

  consume() {
    const delta = this.value
    const truncated = this.dropped
    this.value = ''
    this.dropped = false
    return { delta, truncated }
  }

  snapshot() {
    return { text: this.value, truncated: this.dropped }
  }
}

// ---- send operation ----------------------------------------------------------
class WslSendOperation {
  constructor(maxBytes, onCancel) {
    this.onCancel = onCancel
    this.output = new BoundedTextBuffer(maxBytes)
    this.promise = Promise.withResolvers()
    this.finished = false
    this.cancellationRequested = false
    this.startedAt = Date.now()
  }

  get done() {
    return this.promise.promise
  }

  get settled() {
    return this.finished
  }

  append(text) {
    if (!this.finished) this.output.append(text)
  }

  settle(waitReason, sessionStatus, inheritedTruncation) {
    if (this.finished) return
    this.finished = true
    const read = this.output.snapshot()
    this.promise.resolve({
      viewport: read.text,
      waitReason,
      sessionStatus,
      truncated: read.truncated || inheritedTruncation,
    })
  }

  fail(error) {
    if (this.finished) return
    this.finished = true
    this.promise.reject(error)
  }

  readOutput() {
    return this.output.consume()
  }

  cancel() {
    if (this.finished) return false
    this.cancellationRequested = true
    this.onCancel()
    return true
  }
}

// ---- the backend session -----------------------------------------------------
export class WslPtySession {
  constructor(pty, config, distro) {
    this.pty = pty
    this.config = config
    this.distro = distro
    this.motd = ''
    this.pid = pty.pid
    this.bashPid = undefined
    this.lastPgid = undefined
    this.decoder = new TextDecoder()
    this.sanitizer = new TerminalSanitizer(config.maxReadBytes)
    this.scrollback = new BoundedTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines)
    this.outputEnded = Promise.withResolvers()
    this.statusValue = { kind: 'running' }
    this.active = undefined
    this.activeTimer = undefined
    this.activeDeadlineTimer = undefined
    this.activeAbort = undefined
    this.lastOutputAt = Date.now()
    this.promptSeen = false
    this.promptTextSeen = false
    this.promptTail = ''
    this.initializing = false
    this.closing = false
    this.closePromise = undefined
    this.transportFailure = undefined
    this.output = new PassThrough()
    this.exitOutcome = undefined
    this.dataDisposable = pty.onData((data) => {
      this.output.write(Buffer.from(data, 'utf8'))
      this.onData(data)
    })
    this.exitDisposable = pty.onExit(({ exitCode, signal }) => {
      this.exitOutcome = { exitCode, signal }
      this.output.end()
      this.outputEnded.resolve()
      this.statusValue = { kind: 'exited', exitCode, signal }
      this.settleActive('session_exit')
    })
  }

  async initialize(signal) {
    this.initializing = true
    try {
      const result = await this.startSend({
        text: '',
        submit: false,
        ...(signal !== undefined ? { signal } : {}),
      }).done
      if (result.waitReason === 'session_exit') throw new Error('WSL PTY shell exited during startup')
      if (result.waitReason === 'timeout') throw new Error('WSL PTY shell did not reach readiness before startup timeout')
      this.motd = result.viewport
      if (this.sanitizer.pidCapture !== undefined) this.bashPid = this.sanitizer.pidCapture
    } catch (error) {
      signal?.throwIfAborted()
      throw error
    } finally {
      this.initializing = false
    }
  }

  startSend(request) {
    if (this.closing) throw new Error('PTY session is closing')
    if (this.statusValue.kind === 'exited') throw new Error('PTY session has exited')
    if (this.active !== undefined) throw new TerminalError('PTY session already has an active send', 'SEND_ACTIVE')
    if (request.signal?.aborted === true) throw new Error('PTY send aborted before write')
    const operation = new WslSendOperation(this.config.maxReadBytes, () => {
      this.interrupt(operation)
    })
    this.active = operation
    this.resetReadinessEvidence()
    if (request.signal !== undefined) {
      const onAbort = () => {
        operation.cancel()
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.activeAbort = () => request.signal?.removeEventListener('abort', onAbort)
    }
    this.activeDeadlineTimer = setTimeout(() => {
      if (this.active === operation) this.settleActive('timeout')
    }, this.config.timeoutMs)
    this.beginSend(operation, request)
    return operation
  }

  beginSend(operation, request) {
    const input = `${request.text}${request.submit ? '\r' : ''}`
    if (input.length > 0 && !operation.cancellationRequested) {
      this.resetReadinessEvidence()
      try {
        this.pty.write(input)
      } catch (error) {
        if (this.active === operation && !this.closing) this.failActive(error)
        return
      }
    }
    if (operation.cancellationRequested) return
    if (this.active === operation && !operation.settled && !this.closing) {
      this.schedulePoll(operation)
    }
  }

  resetReadinessEvidence() {
    this.lastOutputAt = Date.now()
    this.promptSeen = false
    this.promptTextSeen = false
    this.promptTail = ''
  }

  read(request) {
    const snapshot = this.scrollback.snapshot()
    const lines = snapshot.text.split('\n')
    const totalLines = snapshot.text.length === 0 ? 0 : lines.length
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('PTY read offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('PTY read count must be a positive safe integer')
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const bounded = utf8Tail(lines.slice(start, end).join('\n'), this.config.maxReadBytes)
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: snapshot.truncated || bounded.truncated,
    }
  }

  /**
   * Resolve the foreground process group on the Linux side through a
   * wsl.exe side-call reading /proc/<bashPid>/stat (field tpgid).
   */
  resolvePgid() {
    if (this.bashPid === undefined) return undefined
    const stat = this.sideCall('sh', '-c', `cat /proc/${this.bashPid}/stat 2>/dev/null`)
    if (stat === undefined) return undefined
    const close = stat.lastIndexOf(')')
    if (close < 0) return undefined
    const fields = stat.slice(close + 2).trim().split(/\s+/)
    const tpgid = Number(fields[5])
    if (Number.isSafeInteger(tpgid) && tpgid > 0) {
      this.lastPgid = tpgid
      return tpgid
    }
    return undefined
  }

  /** Run one short command in the same distro, returning trimmed stdout. */
  sideCall(...args) {
    try {
      const argv = ['wsl.exe']
      if (this.distro !== undefined) argv.push('-d', this.distro)
      argv.push('--', ...args)
      const result = spawnSync('wsl.exe', argv.slice(1), { encoding: 'utf8', timeout: 8000 })
      if (result.status !== 0) return undefined
      return (result.stdout ?? '').trim()
    } catch {
      return undefined
    }
  }

  async signal(signal) {
    if (this.closing) throw new Error('PTY session is closing')
    if (signal === 'SIGINT') {
      // Ctrl-C through ConPTY: wsl.exe turns it into a real SIGINT for the
      // foreground group inside the Linux PTY.
      this.pty.write('\x03')
      return { delivered: true, targetPgid: this.lastPgid ?? this.bashPid ?? this.pid }
    }
    const pgid = this.resolvePgid()
    if (pgid === undefined) throw new Error('cannot resolve foreground process group for the WSL terminal')
    const name = signal.slice(3)
    const killed = this.sideCall('kill', `-${name}`, `-${pgid}`)
    if (killed === undefined) throw new Error(`failed to deliver ${signal} to pgid ${pgid} inside WSL`)
    return { delivered: true, targetPgid: pgid }
  }

  status() {
    return this.statusValue
  }

  close(reason) {
    this.closing = true
    if (this.closePromise !== undefined) return this.closePromise
    const closing = this.closeOnce(reason).catch((error) => {
      this.closePromise = undefined
      this.failActive(error)
      throw error
    })
    this.closePromise = closing
    return closing
  }

  onData(data) {
    const sanitized = this.sanitizer.push(data)
    this.appendOutput(sanitized.text)
    if (sanitized.prompt) {
      this.promptSeen = true
      this.promptTail = ''
      this.lastOutputAt = Date.now()
      if (this.sanitizer.pidCapture !== undefined) {
        this.bashPid = this.sanitizer.pidCapture
      }
    }
    if (this.promptSeen && sanitized.promptTail !== undefined) {
      const remaining = Math.max(0, 6 - this.promptTail.length)
      this.promptTail += sanitized.promptTail.slice(0, remaining)
      if (sanitized.promptTail.length > remaining) this.promptTail = `${CONTROLLED_PROMPT}\0`
      this.promptTextSeen = this.promptTail === CONTROLLED_PROMPT
    }
  }

  appendOutput(text) {
    if (text.length === 0) return
    this.lastOutputAt = Date.now()
    this.scrollback.append(text)
    this.active?.append(text)
  }

  schedulePoll(operation, delayMs = this.config.pollIntervalMs) {
    if (this.active !== operation) return
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = setTimeout(() => {
      this.activeTimer = undefined
      this.pollReadiness(operation)
    }, delayMs)
  }

  pollReadiness(operation) {
    if (this.active !== operation) return
    if (this.statusValue.kind === 'exited') {
      this.settleActive('session_exit')
      return
    }
    const idleFor = Date.now() - this.lastOutputAt
    if (this.promptSeen && this.promptTextSeen && idleFor >= this.config.pollIntervalMs) {
      this.settleActive('stdin_read')
      return
    }
    const elapsed = Date.now() - operation.startedAt
    const startupHasOutput = !this.initializing || this.scrollback.snapshot().text.length > 0
    if (startupHasOutput && idleFor >= this.config.idleSilenceMs) {
      this.settleActive('inferred_idle')
      return
    }
    if (elapsed >= this.config.timeoutMs) {
      this.settleActive('timeout')
      return
    }
    this.schedulePoll(operation)
  }

  settleActive(waitReason) {
    const operation = this.active
    if (operation === undefined) return
    const scrollbackTruncated = this.scrollback.snapshot().truncated
    this.clearActive()
    operation.settle(waitReason, this.statusValue, scrollbackTruncated)
  }

  failActive(error) {
    const operation = this.active
    if (operation === undefined) return
    this.clearActive()
    operation.fail(error)
  }

  clearActive() {
    this.stopPolling()
    this.activeAbort?.()
    this.activeAbort = undefined
    this.active = undefined
  }

  stopPolling() {
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = undefined
    if (this.activeDeadlineTimer !== undefined) clearTimeout(this.activeDeadlineTimer)
    this.activeDeadlineTimer = undefined
  }

  interrupt(operation) {
    if (this.active !== operation) return
    // Foreground interrupt: Ctrl-C through ConPTY, same as SIGINT.
    try {
      this.pty.write('\x03')
    } catch {
      // the PTY already exited; the exit listener settles the operation
    }
  }

  async closeOnce(reason) {
    this.stopPolling()
    try {
      this.pty.kill()
    } catch {
      // already gone; the exit listener settles
    }
    const graceMs = this.config.disposeGraceMs
    const deadline = Date.now() + graceMs
    while (this.statusValue.kind === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (this.statusValue.kind === 'running') {
      try {
        spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        // best-effort final teardown
      }
    }
    this.settleActive('session_exit')
    this.dataDisposable.dispose()
    this.exitDisposable.dispose()
    if (this.transportFailure !== undefined) throw this.transportFailure
    if (this.statusValue.kind === 'running') throw new Error(`WSL PTY cleanup failed (${reason}); surviving pid: ${this.pid}`)
  }
}

// ---- the backend -------------------------------------------------------------
const sandboxModeFences = new WeakMap()

function ensureSandboxModeFence(ctx, owner, terminals) {
  const existing = sandboxModeFences.get(owner)
  if (existing !== undefined) {
    existing.pty = terminals
    existing.sandboxPolicy = ctx.get('sandboxPolicy')
    return
  }
  const state = { pty: terminals, sandboxPolicy: ctx.get('sandboxPolicy') }
  sandboxModeFences.set(owner, state)
  owner.ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args
    if (session !== owner.session || event.type !== 'sandbox/mode') return
    const policy = state.sandboxPolicy
    const currentMode = effectiveSandboxMode(session.events) ?? policy?.defaultMode
    if (event.data.mode === currentMode || !state.pty.hasOwnerActivity(owner)) return
    throw new Error(`cannot change sandbox mode from "${currentMode}" to "${event.data.mode}" while persistent terminal sessions are open or being created; wait for creation to settle and close them first`)
  }, { global: true })
}

export class WslTerminalBackend {
  constructor(ctx, cfg) {
    this.ctx = ctx
    this.cfg = cfg
    this.type = BACKEND_TYPE
    this.config = {
      rows: Number.isSafeInteger(cfg.rows) && cfg.rows > 0 ? cfg.rows : 40,
      cols: Number.isSafeInteger(cfg.cols) && cfg.cols > 0 ? cfg.cols : 160,
      scrollbackLines: 10000,
      scrollbackMaxBytes: 4 * 1024 * 1024,
      maxReadBytes: 256 * 1024,
      pollIntervalMs: 400,
      idleSilenceMs: 3000,
      timeoutMs: Number.isSafeInteger(cfg.ptysTimeoutMs) && cfg.ptysTimeoutMs > 0 ? cfg.ptysTimeoutMs : 30000,
      disposeGraceMs: Number.isSafeInteger(cfg.graceMs) && cfg.graceMs > 0 ? cfg.graceMs : 3000,
    }
  }

  async spawn(spec) {
    spec.signal?.throwIfAborted()
    ensureSandboxModeFence(this.ctx, spec.owner, this.ctx.get('terminals'))
    const sandboxPolicy = this.ctx.get('sandboxPolicy')
    const policy = sandboxPolicy?.resolve !== undefined
      ? sandboxPolicy.resolve({ session: spec.owner.session })
      : undefined
    const gate = gateCheck(policy?.mode)
    if (gate !== null) throw new Error(gate)

    // Live distro choice: the user's saved setting wins over the row config.
    const distro = chosenDistro(this.cfg.distro, this.ctx.get('settings'))

    let nodePty
    try {
      nodePty = await loadNodePty()
    } catch (e) {
      throw e
    }

    const env = childEnvironment(spec)
    const envNames = Object.keys(env)
    const argv = ['wsl.exe']
    if (distro !== undefined) argv.push('-d', distro)
    argv.push('--', 'bash', '--noprofile', '--norc', '-i')

    const pty = nodePty.spawn(argv[0], argv.slice(1), {
      name: 'xterm-color',
      rows: this.config.rows,
      cols: this.config.cols,
      cwd: spec.cwd ?? policy?.workspaceRoot ?? process.cwd(),
      env: {
        // The Windows environment must stay the base: a bare env makes the
        // WSL launcher itself fail (Wsl/Service 0x8007072c).
        ...process.env,
        ...env,
        WSLENV: wslenvFor(process.env.WSLENV, envNames),
      },
    })
    const session = new WslPtySession(pty, this.config, distro)
    try {
      await session.initialize(spec.signal)
      return session
    } catch (error) {
      try {
        await session.close('WSL PTY startup failed')
      } catch (closeError) {
        throw new TerminalBackendCleanupError(error, closeError)
      }
      throw error
    }
  }
}

/** Register the WSL backend into the realm's `terminals` registry. */
export function registerWslBackend(ctx, cfg) {
  const terminals = ctx.get('terminals')
  if (terminals === undefined) return
  const backend = new WslTerminalBackend(ctx, cfg)
  ctx.effect(() => terminals.registerBackend(backend), 'dsh-wsl: WSL terminal backend')
}
