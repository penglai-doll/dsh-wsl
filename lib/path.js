// dsh-wsl — Windows ⇄ WSL path translation.
//
// Pure helpers shared by the host half and the preset-local executor (which
// inlines its own copy, since preset-local files cannot import packages).
//
// Translation rules (WSL2 /mnt model):
//   Windows absolute drive path  D:\foo\bar  ->  /mnt/d/foo/bar
//   Drive root                   C:\         ->  /mnt/c
//   WSL /mnt drive path          /mnt/d/foo  ->  D:\foo
//   POSIX paths already starting with / are left untouched.
//
// Windows UNC paths (\\server\share, \\wsl.localhost\...) have no WSL /mnt
// mapping and yield undefined, as do relative paths: callers decide how to
// fail. `wslpath` exists but mangles backslashes when invoked through
// wsl.exe argv (observed: D:\Project became D:Project), so this module
// computes the mapping directly and never shells out.

/** Translate a Windows-style path into its WSL form. Undefined when unmappable. */
export function toWslPath(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const s = value.replace(/\\/g, '/')
  if (s.startsWith('//')) return undefined // UNC
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

/** Whether a path is a Windows absolute drive-letter path. */
export function isWindowsAbsolute(value) {
  return typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value)
}

/** Whether a path already looks like a POSIX absolute path. */
export function isPosixAbsolute(value) {
  return typeof value === 'string' && value.startsWith('/')
}
