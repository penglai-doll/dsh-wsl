import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeWslOutput, parseDistroList, listDistros, defaultDistro, wslenvFor, warmupDistro } from '../lib/wsl.js'

const DISTRO_UTF8 = [
  '  NAME                   STATE           VERSION',
  '* Ubuntu                 Stopped         2',
  '  archlinux              Stopped         2',
  '  docker-desktop         Stopped         2',
].join('\r\n')

test('decodeWslOutput: UTF-16LE BOM', () => {
  const text = '* Ubuntu Stopped 2\n'
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  assert.equal(decodeWslOutput(buf), text)
})

test('decodeWslOutput: UTF-8 no BOM', () => {
  const buf = Buffer.from('hello world', 'utf8')
  assert.equal(decodeWslOutput(buf), 'hello world')
})

test('decodeWslOutput: empty', () => {
  assert.equal(decodeWslOutput(Buffer.alloc(0)), '')
})

test('parseDistroList', () => {
  const distros = parseDistroList(DISTRO_UTF8)
  assert.equal(distros.length, 3)
  assert.deepEqual(distros[0], { name: 'Ubuntu', state: 'Stopped', version: 2, isDefault: true })
  assert.deepEqual(distros[1], { name: 'archlinux', state: 'Stopped', version: 2, isDefault: false })
  assert.equal(defaultDistro(distros), 'Ubuntu')
})

test('parseDistroList: no default marker', () => {
  const distros = parseDistroList('  NAME  STATE  VERSION\n  Ubuntu Stopped 2\n')
  assert.equal(defaultDistro(distros), undefined)
})

test('listDistros: success through injected exec', () => {
  const exec = () => ({ status: 0, stdout: Buffer.from(DISTRO_UTF8, 'utf8') })
  const result = listDistros(exec)
  assert.equal(result.available, true)
  assert.equal(result.distros.length, 3)
  assert.equal(result.error, null)
})

test('listDistros: failure paths', () => {
  assert.equal(listDistros(() => ({ status: 1, stdout: Buffer.alloc(0) })).available, false)
  const errResult = listDistros(() => ({ error: new Error('no wsl') }))
  assert.equal(errResult.available, false)
  assert.match(errResult.error, /no wsl/)
})

test('wslenvFor', () => {
  assert.equal(wslenvFor('', ['A', 'B']), 'A:B')
  assert.equal(wslenvFor('EXIST', ['A']), 'EXIST:A')
  assert.equal(wslenvFor('A', ['A', 'B']), 'A:B')
  assert.equal(wslenvFor(' A :', ['B']), 'A:B')
  assert.equal(wslenvFor(undefined, []), '')
})

test('warmupDistro: best-effort and injectable', () => {
  let spawned = null
  const exec = (file, args, options) => {
    spawned = { file, args, options }
    return { unref() {} }
  }
  assert.equal(warmupDistro('Ubuntu', exec), true)
  assert.equal(spawned.file, 'wsl.exe')
  assert.deepEqual(spawned.args, ['wsl.exe', '-d', 'Ubuntu', '--', 'true'])
  // throwing exec degrades to false, never throws
  assert.equal(warmupDistro('Ubuntu', () => { throw new Error('boom') }), false)
})
