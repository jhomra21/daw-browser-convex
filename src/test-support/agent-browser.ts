type AgentBrowserOptions = {
  env?: Record<string, string>
  // One deadline per command so a hung page fails the run instead of hanging it.
  timeoutMs?: number
}

// Runs agent-browser commands in one named session. AGENT_BROWSER_CDP and AGENT_BROWSER_SESSION are dropped so
// a developer's own browser session never leaks into a test.
export const agentBrowser = (session: string, options: AgentBrowserOptions = {}) => async (...args: string[]) => {
  const { AGENT_BROWSER_CDP: _cdp, AGENT_BROWSER_SESSION: _session, ...inherited } = process.env

  const child = Bun.spawn(['agent-browser', '--session', session, ...args], {
    env: { ...inherited, ...options.env },
    signal: options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])

  if (await child.exited !== 0) throw new Error(stderr || stdout)

  return stdout.trim()
}
