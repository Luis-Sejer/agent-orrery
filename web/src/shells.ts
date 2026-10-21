import type { Shell } from './types'

// Only loopback addresses ever become links: localhost, a name under .localhost, 127.0.0.1 or ::1.
const LOOPBACK = /^((?:[a-z0-9-]{1,63}\.)*localhost|127\.0\.0\.1|\[::1\])$/

export function shellUrl(shell: Shell): string | null {
  if (shell.port === null || !Number.isInteger(shell.port) || shell.port <= 0 || shell.port > 65_535) return null
  const host = shell.host && LOOPBACK.test(shell.host) ? shell.host : 'localhost'
  return `http://${host}:${shell.port}`
}

// ":3005", or "app.localhost:3005" when it isn't plain localhost.
export function shellAddress(shell: Shell): string | null {
  if (shell.port === null) return null
  return shell.host && shell.host !== 'localhost' ? `${shell.host}:${shell.port}` : `:${shell.port}`
}

// The short form for a chip: a name under .localhost keeps only its first label, as servers behind a
// local router share a port and differ by that name ("bug-fix.juristic.localhost:3005" is "bug-fix:3005").
export function shellLabel(shell: Shell): string | null {
  if (shell.port === null) return null
  const name = shell.host?.match(/^([^.]+)\.(?:[^.]+\.)*localhost$/)?.[1]
  return name ? `${name}:${shell.port}` : shellAddress(shell)
}

// Opened from a satellite or a chip; the drawer has the same as plain links, for the keyboard.
export function openShell(shell: Shell) {
  const url = shellUrl(shell)
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}
