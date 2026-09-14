// Protocol-level probe against a running instance's interconnect link.
// Reads the bearer token from IC_TOKEN (never printed) and exercises the same
// path a peer uses: WS upgrade with auth, then query frames.
const WebSocket = require(process.env.IC_WS ?? '/home/ubuntu/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules/ws')
const token = process.env.IC_TOKEN ?? ''
const ws = new WebSocket(`ws://127.0.0.1:${process.env.IC_PORT ?? '3080'}/interconnect/link`, {
  headers: { authorization: `Bearer ${token}` },
})
let results = 0
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', sender: 'probe' }))
  ws.send(JSON.stringify({ type: 'query', reqId: 'q1', query: { kind: 'ping' } }))
  ws.send(JSON.stringify({ type: 'query', reqId: 'q2', query: { kind: 'list' } }))
})
ws.on('message', (data) => {
  let frame
  try { frame = JSON.parse(String(data)) } catch { console.log('NON-JSON'); return }
  if (frame.type === 'hello') { console.log('hello from:', frame.sender); return }
  if (frame.type !== 'query-result') return
  results += 1
  const result = frame.result ?? {}
  if (result.pong !== undefined) {
    console.log(`ping: pong=${String(result.pong)} instance=${String(result.instance)}`)
  } else if (Array.isArray(result.sessions)) {
    console.log(`list: sessions=${String(result.sessions.length)}`)
    for (const row of result.sessions.slice(0, 3)) {
      console.log(`  row: ${String(row.sessionId)} | title=${String(row.title ?? '-')} | status=${String(row.status ?? '-')}`)
    }
  } else {
    console.log('other result:', JSON.stringify(result).slice(0, 140))
  }
  if (results >= 2) { ws.close(); process.exit(0) }
})
ws.on('unexpected-response', (_req, res) => { console.error('HTTP-STATUS', res.statusCode); process.exit(2) })
ws.on('error', (err) => { console.error('WS-ERR', err.message); process.exit(1) })
setTimeout(() => { console.error('TIMEOUT results=' + String(results)); process.exit(3) }, 15000)
