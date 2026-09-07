import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
const testFiles = new Map([['/ui-preview.js', 'ui-preview.js'], ['/article.html', 'article.html'], ['/flink-layout.html', 'flink-layout.html'], ['/sidepanel-layout.html', 'sidepanel-layout.html'], ['/interaction-preview.html', 'interaction-preview.html']]);
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' };

// 只在环回地址展示生成的页面；生产安装包不含该模拟服务。
http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const testFile = testFiles.get(pathname);
    const file = testFile ? resolve(root, 'tests', testFile) : resolve(dist, `.${pathname === '/' ? '/popup.html' : pathname}`);
    if (!testFile && !file.startsWith(dist + sep)) { res.writeHead(403); res.end(); return; }
    let data = await readFile(file);
    if (!testFile && extname(file) === '.html') data = Buffer.from(data.toString().replace('<head>', '<head><script src="/ui-preview.js"></script>'));
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end('未找到预览资源'); }
}).listen(4177, '127.0.0.1', () => console.log(`页伴本地界面验收：http://127.0.0.1:4177/popup.html，进程：${process.pid}`));
