'use strict';
// Minimal newline-delimited JSON-RPC 2.0 client over a child process's stdio.
// The bundled agent runtime speaks JSONL (one JSON-RPC message per line) on stdin/stdout.
const { EventEmitter } = require('events');

class JsonRpcStdio extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this._buf = '';
    child.stdout.on('data', (chunk) => this._onData(chunk));
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue; // ignore non-JSON log lines that may leak to stdout
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(Object.assign(new Error(msg.error.message || 'rpc error'), { data: msg.error }));
      else resolve(msg.result);
      return;
    }
    // Server-initiated request (needs a response) — e.g. approvals/elicitation
    if (msg.id !== undefined && msg.method) {
      this.emit('serverRequest', msg);
      return;
    }
    // Notification
    if (msg.method) {
      this.emit('notification', msg.method, msg.params || {});
    }
  }

  _write(obj) {
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._write({ id, method, params: params || {} });
    });
  }

  notify(method, params) {
    this._write({ method, params: params || {} });
  }

  respond(id, result) {
    this._write({ id, result: result || {} });
  }

  respondError(id, code, message) {
    this._write({ id, error: { code: code || -32000, message: message || 'error' } });
  }
}

module.exports = { JsonRpcStdio };
