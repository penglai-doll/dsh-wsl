import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toWslPath, toWindowsPath, isWindowsAbsolute, isPosixAbsolute } from '../lib/path.js'
import { toWslPath as xToWslPath, toWindowsPath as xToWindowsPath } from '../agent-presets/minimal-wsl/wsl-executor.mjs'

const cases = [
  // [windows input, expected wsl output]
  ['D:\\Project\\DSH-Plugins', '/mnt/d/Project/DSH-Plugins'],
  ['D:/Project/DSH-Plugins', '/mnt/d/Project/DSH-Plugins'],
  ['C:\\', '/mnt/c'],
  ['C:', '/mnt/c'],
  ['d:\\foo\\bar', '/mnt/d/foo/bar'],
  ['/usr/bin', '/usr/bin'],
  ['/mnt/d/foo', '/mnt/d/foo'],
  ['\\\\server\\share\\x', undefined],
  ['relative\\x', undefined],
  ['', undefined],
  [undefined, undefined],
]

test('lib/path toWslPath', () => {
  for (const [input, expected] of cases) {
    assert.equal(toWslPath(input), expected, `toWslPath(${JSON.stringify(input)})`)
  }
})

test('executor toWslPath matches lib/path', () => {
  for (const [input, expected] of cases) {
    assert.equal(xToWslPath(input), expected, `executor toWslPath(${JSON.stringify(input)})`)
  }
})

test('toWindowsPath', () => {
  assert.equal(toWindowsPath('/mnt/d/Project/DSH-Plugins'), 'D:\\Project\\DSH-Plugins')
  assert.equal(toWindowsPath('/mnt/c'), 'C:\\')
  assert.equal(toWindowsPath('/mnt/d'), 'D:\\')
  assert.equal(toWindowsPath('/home/user'), undefined)
  assert.equal(toWindowsPath('D:\\x'), undefined)
  assert.equal(xToWindowsPath('/mnt/d/Project'), 'D:\\Project')
})

test('absolute-path classifiers', () => {
  assert.equal(isWindowsAbsolute('D:\\x'), true)
  assert.equal(isWindowsAbsolute('D:/x'), true)
  assert.equal(isWindowsAbsolute('d:\\x'), true)
  assert.equal(isWindowsAbsolute('/mnt/d'), false)
  assert.equal(isWindowsAbsolute('x\\y'), false)
  assert.equal(isPosixAbsolute('/mnt/d'), true)
  assert.equal(isPosixAbsolute('D:\\x'), false)
})
