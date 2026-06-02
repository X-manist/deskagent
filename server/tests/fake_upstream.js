// Fake OpenAI-compatible /v1/responses upstream for metering tests.
const http = require('http');

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/responses') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}
      const mode = parsed.test_mode || 'normal';
      const total = parsed.test_total_tokens || 1234;

      if (mode === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"upstream boom"}}');
        return;
      }

      if (mode === 'nousage') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n');
        res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n');
        return;
      }
      if (mode === 'slow') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"a"}\n\n');
        setTimeout(() => {
          res.end(`event: response.completed\ndata: {"type":"response.completed","response":{"id":"slow","usage":{"input_tokens":10,"output_tokens":20,"total_tokens":${total}}}}\n\n`);
        }, 800);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n');
      res.end(`event: response.completed\ndata: {"type":"response.completed","response":{"id":"ok","usage":{"input_tokens":100,"output_tokens":200,"total_tokens":${total}}}}\n\n`);
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(8798, '127.0.0.1', () => console.log('fake-upstream on 8798'));
