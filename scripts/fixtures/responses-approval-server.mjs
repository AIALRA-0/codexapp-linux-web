import { createServer } from 'node:http';

const port = Number.parseInt(process.env.APPROVAL_FIXTURE_PORT ?? '', 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('APPROVAL_FIXTURE_PORT must be a valid TCP port');
}

const acceptedMarker = process.env.APPROVAL_ACCEPTED_MARKER;
const declinedMarker = process.env.APPROVAL_DECLINED_MARKER;
if (acceptedMarker === undefined || declinedMarker === undefined) {
  throw new Error('APPROVAL_ACCEPTED_MARKER and APPROVAL_DECLINED_MARKER are required');
}

const responses = [
  shellCommandResponse(
    'approval-accept-command',
    `printf '%s\\n' accepted | tee ${shellQuote(acceptedMarker)}`,
  ),
  assistantResponse('approval-accepted-message', 'approved command completed'),
  shellCommandResponse(
    'approval-decline-command',
    `printf '%s\\n' declined > ${shellQuote(declinedMarker)}`,
  ),
  assistantResponse('approval-declined-message', 'declined command was not executed'),
];
const requests = [];
const observedRoutes = [];

const server = createServer(async (request, response) => {
  observedRoutes.push({ method: request.method, url: request.url });
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, remainingResponses: responses.length }));
    return;
  }
  if (request.method === 'GET' && request.url === '/requests') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ observedRoutes, requests, remainingResponses: responses.length }),
    );
    return;
  }
  if (request.method !== 'POST' || request.url?.split('?')[0] !== '/v1/responses') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const body = await readJsonBody(request);
  requests.push(body);
  const next = responses.shift();
  if (next === undefined) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'approval fixture response sequence exhausted' }));
    return;
  }
  response.writeHead(200, {
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'content-type': 'text/event-stream',
  });
  response.end(next);
});

server.listen(port, '127.0.0.1');

function shellCommandResponse(callId, command) {
  return sse([
    {
      type: 'response.created',
      response: { id: `response-${callId}` },
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: callId,
        name: 'shell_command',
        arguments: JSON.stringify({ command, timeout_ms: 5_000 }),
      },
    },
    completedEvent(`response-${callId}`),
  ]);
}

function assistantResponse(id, text) {
  return sse([
    { type: 'response.created', response: { id: `response-${id}` } },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        id,
        content: [{ type: 'output_text', text }],
      },
    },
    completedEvent(`response-${id}`),
  ]);
}

function completedEvent(id) {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function sse(events) {
  return `${events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`)
    .join('\n')}\n`;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
