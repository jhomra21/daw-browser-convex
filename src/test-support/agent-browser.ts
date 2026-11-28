// Runs agent-browser commands in one named session. AGENT_BROWSER_CDP and AGENT_BROWSER_SESSION are dropped so
// a developer's own browser session never leaks into a test.
export const agentBrowser = (session: string) => async (...args: string[]) => {
  const env = { ...process.env }
  delete env.AGENT_BROWSER_CDP
  delete env.AGENT_BROWSER_SESSION
  const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])

  if (await child.exited !== 0) throw new Error(stderr || stdout)

  return stdout.trim()
}
