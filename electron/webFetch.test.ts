import { describe, it, expect } from 'vitest'
import { isBlockedAddress, isBlockedHostname, validateFetchUrl } from './webFetch'

describe('isBlockedAddress', () => {
  it('blocks IPv4 private/loopback/link-local/CGNAT ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true)
    }
  })

  it('allows public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255']) {
      expect(isBlockedAddress(ip)).toBe(false)
    }
  })

  it('blocks IPv6 loopback/link-local/unique-local/multicast and IPv4-mapped equivalents', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe']) {
      expect(isBlockedAddress(ip)).toBe(true)
    }
  })

  it('allows public IPv6 and IPv4-mapped public addresses', () => {
    for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip)).toBe(false)
    }
  })

  it('blocks non-IP input', () => {
    expect(isBlockedAddress('example.com')).toBe(true)
  })
})

describe('isBlockedHostname', () => {
  it('blocks localhost and reserved suffixes', () => {
    for (const h of ['localhost', 'LOCALHOST', 'foo.localhost', 'printer.local', 'db.internal']) {
      expect(isBlockedHostname(h)).toBe(true)
    }
  })

  it('allows ordinary public hostnames', () => {
    expect(isBlockedHostname('example.com')).toBe(false)
  })
})

describe('validateFetchUrl', () => {
  it('rejects non-http(s) schemes', () => {
    expect(validateFetchUrl('file:///etc/passwd').ok).toBe(false)
    expect(validateFetchUrl('ftp://example.com').ok).toBe(false)
  })

  it('rejects embedded credentials', () => {
    expect(validateFetchUrl('http://user:pass@example.com').ok).toBe(false)
  })

  it('rejects local hostnames and literal loopback/private IPs', () => {
    expect(validateFetchUrl('http://localhost/').ok).toBe(false)
    expect(validateFetchUrl('http://127.0.0.1/').ok).toBe(false)
    expect(validateFetchUrl('http://192.168.1.1/').ok).toBe(false)
    expect(validateFetchUrl('http://[::1]/').ok).toBe(false)
  })

  it('accepts an ordinary public https URL', () => {
    const result = validateFetchUrl('https://example.com/page')
    expect(result.ok).toBe(true)
    expect(result.hostname).toBe('example.com')
  })

  it('rejects malformed URLs', () => {
    expect(validateFetchUrl('not a url').ok).toBe(false)
  })
})

describe('validateFetchUrl with mapped literals', () => {
  it('refuses IPv4-mapped loopback in bracketed URL form', () => {
    expect(validateFetchUrl('http://[::ffff:127.0.0.1]/').ok).toBe(false)
  })
})
