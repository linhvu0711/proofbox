# Serves events.html on 127.0.0.1:8123 and appends each POST body as one
# line to /tmp/proofbox-events/events.jsonl, for the macOS Pixel tests.
import http.server
import socketserver

LOG = "/tmp/proofbox-events/events.jsonl"


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with open(LOG, "ab") as log:
            log.write(body + b"\n")
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    # HTTPServer.server_bind looks up the host name, which on macOS asks
    # for local network access in an alert over the page.
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


Server(("127.0.0.1", 8123), Handler).serve_forever()
