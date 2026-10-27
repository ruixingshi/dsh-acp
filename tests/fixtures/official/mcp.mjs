/** Minimal external MCP fixture for the ACP stdio negotiation and tool bridge. */
import { createInterface } from 'node:readline'

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  let result
  switch (method) {
    case 'initialize':
      result = {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      }
      break
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'add',
            description: 'Add two numbers.',
            inputSchema: {
              type: 'object',
              properties: { a: { type: 'number' }, b: { type: 'number' } },
              required: ['a', 'b'],
            },
          },
        ],
      }
      break
    case 'tools/call':
      result = {
        content: [{ type: 'text', text: String(params.arguments.a + params.arguments.b) }],
      }
      break
    case 'ping':
      result = {}
      break
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'Method not found' },
        }) + '\n',
      )
      continue
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}
