// Drives the built spike binary through tauri-driver (WebDriver) with plain fetch.
// Run after `npx tauri build --no-bundle`: node --test spike/e2e/probe.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const app = resolve(`src-tauri/target/release/sailor-spike${process.platform === 'win32' ? '.exe' : ''}`)
const url = 'http://127.0.0.1:4444'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wd(method, path, body) {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`)
  return json.value
}

test('spike renders a PDF and blocks traversal', { timeout: 120_000 }, async () => {
  const env = { ...process.env, SPIKE_PROJECT: resolve('samples/project.example.json') }
  const driver = spawn('tauri-driver', [], { stdio: 'inherit', env })
  let session
  try {
    for (let i = 0; ; i++) {
      try { await wd('GET', '/status'); break } catch (e) { if (i > 30) throw e; await sleep(500) }
    }
    session = (await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: app } } } })).sessionId
    let log = ''
    for (let i = 0; i < 60 && !/RENDER OK|ERROR/.test(log); i++) {
      await sleep(1000)
      log = await wd('POST', `/session/${session}/execute/sync`, { script: "return document.getElementById('log')?.textContent ?? ''", args: [] })
    }
    console.log(log)
    assert.match(log, /RENDER OK/)
    assert.match(log, /-> 403/)
  } finally {
    if (session) await wd('DELETE', `/session/${session}`).catch(() => {})
    driver.kill()
  }
})
