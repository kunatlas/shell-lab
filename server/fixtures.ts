import type { FixtureSpec } from './exercises.js';
import { sshFixtureProgram } from './ssh-fixture.js';

// These programs are owned by the application; models never supply executable code.
export function fixtureProgram(fixture: FixtureSpec): string {
  if (fixture.kind === 'ssh') return sshFixtureProgram(fixture);
  if (fixture.kind === 'worker') return `
import os, signal
from pathlib import Path
Path('worker.pid').write_text(str(os.getpid()) + '\\n')
while True:
    signal.pause()
`;
  return `
import json, os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
config = json.loads(Path('server-data.json').read_text())
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        with open('requests.log', 'a') as log:
            log.write(self.path + '\\n')
        with open('requests.jsonl', 'a') as log:
            log.write(json.dumps({'path': self.path, 'host': self.headers.get('Host', '')}) + '\\n')
        host_ok = not config.get('host') or self.headers.get('Host', '').split(':')[0] == config['host']
        ok = self.path == config['route'] and host_ok
        body = json.dumps(config['payload'] if ok else {'error': 'not found'}).encode()
        self.send_response(200 if ok else 404)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Service', config['payload'].get('service', 'shell-lab'))
        if config.get('requestId'):
            self.send_header('X-Request-Id', config['requestId'])
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
Path('endpoint.txt').write_text('http://127.0.0.1:' + str(server.server_port) + '\\n')
Path('port.txt').write_text(str(server.server_port) + '\\n')
Path('server.pid').write_text(str(os.getpid()) + '\\n')
server.serve_forever()
`;
}

export const fixtureReadyFile = (fixture: FixtureSpec) => `${fixture.directory}/${fixture.kind === 'ssh' ? 'ssh-ready' : fixture.kind === 'http' ? 'endpoint.txt' : 'worker.pid'}`;
