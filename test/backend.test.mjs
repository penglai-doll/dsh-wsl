// Sanitizer + session readiness unit tests (no live WSL needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TerminalSanitizer, WslPtySession, chosenDistro } from '../lib/backend.js'

test('backend chosenDistro: settings win, config falls back', () => {
  assert.equal(chosenDistro('Ubuntu', undefined), 'Ubuntu')
  assert.equal(chosenDistro('Ubuntu', { get: () => ({ distro: 'archlinux' }) }), 'archlinux')
  assert.equal(chosenDistro('Ubuntu', { get: () => ({ distro: '' }) }), 'Ubuntu')
  assert.equal(chosenDistro('Ubuntu', { get: () => { throw new Error('no ns') } }), 'Ubuntu')
})

const FULL = '\u001b[?25h\u001b]777;pid;290\u0007\u001b]133;D;0\u0007dsh> '

test('sanitizer: no leaks and pid capture across every chunk split', () => {
  for (let split = 0; split <= FULL.length; split += 1) {
    const s = new TerminalSanitizer(256 * 1024)
    let out = ''
    let prompt = false
    for (const part of [FULL.slice(0, split), FULL.slice(split)]) {
      if (part.length === 0) continue
      const r = s.push(part)
      out += r.text
      if (r.prompt) prompt = true
    }
    // The only legitimate text is the controlled prompt tail; any '['
    // or ']' means a control-sequence body leaked.
    assert.ok(!out.includes('[') && !out.includes(']'), `control-sequence leak at split ${split}: ${JSON.stringify(out)}`)
    assert.ok(out === '' || out === 'dsh> ', `unexpected text at split ${split}: ${JSON.stringify(out)}`)
    assert.equal(prompt, true, `prompt marker missed at split ${split}`)
    assert.equal(s.pidCapture, 290, `pid capture failed at split ${split}`)
  }
})

test('sanitizer: 133;D payload with BEL terminator is stripped exactly once', () => {
  const s = new TerminalSanitizer(1024)
  const r = s.push('\u001b]133;D;0\u0007ok')
  assert.equal(r.text, 'ok')
  assert.equal(r.prompt, true)
})

test('sanitizer: stray OSC body without ESC is not leaked as text', () => {
  const s = new TerminalSanitizer(1024)
  // Simulate the historical double-advance artifact: a bare ] payload.
  const r = s.push(']777;pid;290\u0007tail')
  assert.equal(r.text, 'tail')
})

// ---- WslPtySession over a fake pty ------------------------------------------

class FakePty {
  constructor() {
    this.handlers = []
    this.dataHandlers = []
    this.exitHandlers = []
    this.pid = 4242
    this.written = ''
  }
  onData(fn) {
    this.dataHandlers.push(fn)
    return { dispose: () => { this.dataHandlers = this.dataHandlers.filter((f) => f !== fn) } }
  }
  onExit(fn) {
    this.exitHandlers.push(fn)
    return { dispose: () => { this.exitHandlers = this.exitHandlers.filter((f) => f !== fn) } }
  }
  write(text) {
    this.written += text
  }
  kill() {
    this.emitExit(1)
  }
  emitData(text) {
    for (const fn of this.dataHandlers) fn(text)
  }
  emitExit(exitCode) {
    for (const fn of this.exitHandlers) fn({ exitCode, signal: undefined })
  }
}

const CONFIG = {
  rows: 40, cols: 160, scrollbackLines: 10000, scrollbackMaxBytes: 4 * 1024 * 1024,
  maxReadBytes: 256 * 1024, pollIntervalMs: 20, idleSilenceMs: 300, timeoutMs: 2000,
  disposeGraceMs: 500,
}

test('WslPtySession: prompt marker settles stdin_read with clean viewport', async () => {
  const pty = new FakePty()
  const session = new WslPtySession(pty, CONFIG, 'Ubuntu')
  pty.emitData('\u001b]777;pid;290\u0007\u001b]133;D;0\u0007dsh> ')
  const op = session.startSend({ text: 'echo hi', submit: true })
  assert.equal(pty.written, 'echo hi\r')
  // command output + next prompt
  pty.emitData('echo hi\r\nhi\r\n\u001b]777;pid;290\u0007\u001b]133;D;0\u0007dsh> ')
  const result = await op.done
  assert.equal(result.waitReason, 'stdin_read')
  assert.equal(result.sessionStatus.kind, 'running')
  assert.ok(result.viewport.includes('hi'))
  assert.ok(!result.viewport.includes(']777'))
  assert.equal(session.bashPid, 290)
  session.close('done')
})

test('WslPtySession: idle silence settles inferred_idle', async () => {
  const pty = new FakePty()
  const session = new WslPtySession(pty, CONFIG, 'Ubuntu')
  pty.emitData('\u001b]777;pid;290\u0007\u001b]133;D;0\u0007dsh> ')
  const op = session.startSend({ text: 'tail -f', submit: true })
  pty.emitData('streaming output line 1\n')
  const result = await op.done
  assert.equal(result.waitReason, 'inferred_idle')
  session.close('done')
})

test('WslPtySession: session exit settles with session_exit', async () => {
  const pty = new FakePty()
  const session = new WslPtySession(pty, CONFIG, 'Ubuntu')
  pty.emitData('\u001b]777;pid;290\u0007\u001b]133;D;0\u0007dsh> ')
  const op = session.startSend({ text: 'exit', submit: true })
  pty.emitExit(0)
  const result = await op.done
  assert.equal(result.waitReason, 'session_exit')
  assert.equal(session.status().kind, 'exited')
  session.close('done')
})

test('WslPtySession: cancel writes Ctrl-C', () => {
  const pty = new FakePty()
  const session = new WslPtySession(pty, CONFIG, 'Ubuntu')
  pty.emitData('\u001b]777;pid;290\u0007\u001b]133;D;0\u0007dsh> ')
  const op = session.startSend({ text: 'sleep 10', submit: true })
  assert.equal(op.cancel(), true)
  assert.ok(pty.written.endsWith('\x03'))
  session.close('done')
})

test('WslPtySession: second concurrent send is refused', () => {
  const pty = new FakePty()
  const session = new WslPtySession(pty, CONFIG, 'Ubuntu')
  pty.emitData('\u001b]777;pid;290\u0007\u001b]133;D;0\u0007dsh> ')
  session.startSend({ text: 'one', submit: true })
  assert.throws(() => session.startSend({ text: 'two', submit: true }), /already has an active send/)
  session.close('done')
})
