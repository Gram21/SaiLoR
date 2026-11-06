import { describe, it, expect } from 'vitest'
import { pushStash } from './stashOps'

describe('pushStash', () => {
  it('passes the project file as a literal pathspec', async () => {
    const calls: string[][] = []
    const run = async (args: string[]) => {
      calls.push(args)
      return { ok: true, code: 0, stdout: args[0] === 'status' ? ' M a[1]*.json\0' : '', stderr: '' }
    }
    await pushStash(run, 'a[1]*.json', {}, 'm')
    expect(calls[1].slice(-2)).toEqual(['--', ':(literal)a[1]*.json'])
  })
})
