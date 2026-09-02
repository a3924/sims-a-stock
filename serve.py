# serve.py — 本地静态服务器：每次请求都重写脚本 URL 为唯一戳，杜绝任何层级缓存（含忽略 query 的缓存）
import http.server, socketserver, re, os, time

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 8123

# 把 index.html 里 <script src="x.js?v=N"> 改写成 /__bust<ts>/x.js，使每次页面加载都拉取全新脚本
SCRIPT_RE = re.compile(r'(<script\s+src=")([^"?]+)(\?[^"]*)?(")')

def rewrite_html(body: bytes) -> bytes:
    ts = int(time.time() * 1000)
    def repl(m):
        name = m.group(2)
        return '%s/__bust%d/%s%s' % (m.group(1), ts, name, m.group(4))
    return SCRIPT_RE.sub(repl, body.decode('utf-8', 'replace')).encode('utf-8')

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?', 1)[0]
        # 唯一戳路径：/__bust123/app.js -> 真实文件 app.js
        m = re.match(r'^/__bust\d+/(.+)$', path)
        if m:
            path = '/' + m.group(1)
        fp = os.path.normpath(os.path.join(ROOT, path.lstrip('/')))
        if not fp.startswith(ROOT) or not os.path.isfile(fp):
            self.send_error(404); return
        with open(fp, 'rb') as f:
            data = f.read()
        if fp.endswith('.html'):
            data = rewrite_html(data)
        self.send_response(200)
        self.send_header('Content-Type', self.guess_type(fp))
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):  # 兜底，所有响应都不缓存
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *a):  # 静默
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print('unique-bust server on http://127.0.0.1:%d' % PORT)
    httpd.serve_forever()
