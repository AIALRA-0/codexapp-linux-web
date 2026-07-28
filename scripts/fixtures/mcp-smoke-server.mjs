import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message === null || typeof message !== 'object' || message.id === undefined) return;

  try {
    respond(message.id, handleRequest(message.method, message.params));
  } catch (error) {
    respondError(message.id, error instanceof Error ? error.message : 'MCP smoke failure');
  }
});

function handleRequest(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'codexapp-official-web-host-smoke',
          version: '1.0.0',
        },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: [
          {
            name: 'echo',
            description: 'Returns the supplied smoke-test marker.',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    case 'tools/call': {
      if (params?.name !== 'echo' || typeof params?.arguments?.value !== 'string') {
        throw new Error('invalid echo tool call');
      }
      const value = params.arguments.value;
      return {
        content: [{ type: 'text', text: value }],
        structuredContent: { value },
        isError: false,
      };
    }
    default:
      throw new Error(`unsupported MCP smoke method: ${String(method)}`);
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, message) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32_601, message },
    })}\n`,
  );
}
