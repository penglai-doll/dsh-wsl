// dsh-wsl — WSL runtime facts: distro discovery, environment forwarding,
// warm-up. Everything that talks to wsl.exe goes through an injectable
// `exec` so the parsing logic stays unit-testable; the host half supplies
// the real child_process implementation.

import { spawn, spawnSync } from 'node:child_process'

/**
 * Decode wsl.exe output. wsl.exe writes UTF-16LE to pipes on many builds
 * (and UTF-8 on others), so sniff the buffer: a UTF-16LE BOM or a high
 * ratio of NUL bytes selects UTF-16LE, otherwise UTF-8.
 */
export function decodeWslOutput(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return ''
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  const sample = Math.min(buffer.length, 512)
  let nul = 0
  for (let i = 0; i < sample; i += 1) if (buffer[i] === 0) nul += 1
  if (nul > sample / 4) return buffer.toString('utf16le')
  return buffer.toString('utf8')
}

/** One WSL distribution from `wsl.exe -l -v`. */
export function parseDistroList(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const distros = []
  for (const raw of lines) {
    // Format: "  NAME      STATE      VERSION" with an optional "* " default marker.
    const m = /^\s*(\*)?\s*([^\s*]+)\s+(Running|Stopped|Installing|Uninstalling|Converting|Unknown)\s+(\d+)\s*$/.exec(raw)
    if (m === null) continue
    distros.push({
      name: m[2],
      state: m[3],
      version: Number(m[4]),
      isDefault: m[1] === '*',
    })
  }
  return distros
}

/**
 * Parse `wsl.exe -l -v` output (raw buffer) into distro records.
 * `exec` shape: (file, args) => { status, stdout?: Buffer|string, error? }.
 */
export function listDistros(exec = defaultExec) {
  const result = exec('wsl.exe', ['-l', '-v'])
  if (result.error !== undefined && result.error !== null) return { available: false, distros: [], error: String(result.error?.message ?? result.error) }
  if (result.status !== 0) return { available: false, distros: [], error: `wsl -l -v exited with status ${result.status}` }
  try {
    return { available: true, distros: parseDistroList(decodeWslOutput(result.stdout)), error: null }
  } catch (e) {
    return { available: false, distros: [], error: String(e?.message ?? e) }
  }
}

/** The default distro name, or undefined when none is marked. */
export function defaultDistro(distros) {
  const marked = distros.find((d) => d.isDefault)
  return marked === undefined ? undefined : marked.name
}

/**
 * Merge the env-entry names to forward into WSLENV. WSL does not inherit the
 * Windows process environment automatically, so every entry the Linux side
 * needs is listed by name here; existing WSLENV entries are preserved.
 */
export function wslenvFor(existingWslEnv, names) {
  const existing = String(existingWslEnv ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return [...new Set([...existing, ...names])].join(':')
}

/** Fire-and-forget warm-up so the first real command skips the VM cold boot. */
export function warmupDistro(distro, exec = defaultExec) {
  try {
    const argv = ['wsl.exe']
    if (distro !== undefined && distro.length > 0) argv.push('-d', distro)
    argv.push('--', 'true')
    const child = exec('wsl.exe', argv, { detached: true, stdio: 'ignore' })
    if (child !== undefined && typeof child.unref === 'function') child.unref()
    return true
  } catch {
    return false
  }
}

/** The real child_process-backed exec used by the host half. */
export function defaultExec(file, args, options) {
  if (options !== undefined) return spawn(file, args, options)
  return spawnSync(file, args, { encoding: null, timeout: 15000, maxBuffer: 4 * 1024 * 1024 })
}
