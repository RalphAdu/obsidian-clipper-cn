#!/usr/bin/env python3
# Localhost POST receiver for obsidian-clipper test bridge.
# Honours `?path=<absolute-path>` query (preserves UTF-8 + spaces),
# replies with CORS + Chrome Private-Network-Access headers so HTTPS
# pages (scys.com etc.) can POST to http://127.0.0.1 from a content script.
# Stays alive — multiple POSTs OK in one session.
import sys, http.server, socketserver, urllib.parse, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 17923

class H(http.server.BaseHTTPRequestHandler):
    def _cors(self, status=200):
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def do_OPTIONS(self):
        self._cors(204)
        self.end_headers()

    def do_POST(self):
        qs = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(qs)
        path_param = params.get('path', [''])[0]
        path = path_param or '/tmp/feishu-out.md'
        n = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(n)
        try:
            os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
            with open(path, 'wb') as f:
                f.write(body)
            self._cors(200)
            self.end_headers()
            self.wfile.write(f'OK {len(body)} -> {path}'.encode('utf-8'))
        except Exception as e:
            self._cors(500)
            self.end_headers()
            self.wfile.write(f'ERR {e}'.encode('utf-8'))

    def log_message(self, fmt, *args):
        sys.stderr.write(f'[recv] {self.address_string()} {fmt % args}\n')

with socketserver.TCPServer(('127.0.0.1', PORT), H) as srv:
    print(f'Listening on {PORT}', flush=True)
    srv.serve_forever()
