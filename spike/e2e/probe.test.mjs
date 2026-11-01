// Drives the built spike binary through tauri-driver (WebDriver) with plain fetch.
// Run: SPIKE_PROJECT=<abs path to project json> node --test spike/e2e/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const app = resolve(`src-tauri/target/release/sailor-spike${process.platform === 'win32' ? '.exe' : ''}`)
const url = 'http://127.0.0.1:4444'
const ELEMENT = 'element-6066-11e4-a4c6-4a5c3c5f5f6c'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wd(method, path, body) {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`)
  return json.value
}

test('spike renders a PDF and blocks traversal', { timeout: 120_000 }, async () => {
  const args = process.env.NATIVE_DRIVER ? ['--native-driver', process.env.NATIVE_DRIVER] : []
  const driver = spawn('tauri-driver', args, { stdio: 'inherit' })
  let session
  try {
    for (let i = 0; ; i++) {
      try { await wd('GET', '/status'); break } catch (e) { if (i > 30) throw e; await sleep(500) }
    }
    session = (await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: app } } } })).sessionId
    let log = ''
    for (let i = 0; i < 60 && !/RENDER OK|ERROR/.test(log); i++) {
      await sleep(1000)
      const el = await wd('POST', `/session/${session}/element`, { using: 'css selector', value: '#log' })
      log = await wd('GET', `/session/${session}/element/${el[ELEMENT]}/text`)
    }
    console.log(log)
    assert.match(log, /RENDER OK/)
    assert.match(log, /-> 403/)
  } finally {
    if (session) await wd('DELETE', `/session/${session}`).catch(() => {})
    driver.kill()
  }
})
