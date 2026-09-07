import { build } from 'vite';
import { mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = resolve(root, 'dist');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

// 扩展页面使用本地打包资源，网页脚本单独输出为可注入的 IIFE。
await build({
  root, configFile: false, base: './',
  build: { outDir, emptyOutDir: true, sourcemap: false, rollupOptions: { input: { popup: resolve(root, 'popup.html'), options: resolve(root, 'options.html'), sidepanel: resolve(root, 'sidepanel.html') } } },
});
for (const [entry, format, filename] of [['src/content/index.ts', 'iife', 'content.js'], ['src/background/index.ts', 'es', 'background.js']]) {
  await build({
    root, configFile: false, publicDir: false,
    build: { outDir, emptyOutDir: false, sourcemap: false, lib: { entry: resolve(root, entry), name: 'YeBan', formats: [format], fileName: () => filename } },
  });
}

const manifest = {
  manifest_version: 3,
  name: '页伴翻译',
  short_name: '页伴翻译',
  version,
  description: '一页双语，随手即译。支持网页双语、点击划词、悬浮球和文本翻译侧边栏，可配置百炼与阿里云机器翻译。',
  minimum_chrome_version: '116',
  permissions: ['activeTab', 'scripting', 'storage', 'sidePanel'],
  host_permissions: [
    'https://dashscope.aliyuncs.com/*',
    'https://dashscope-intl.aliyuncs.com/*',
    'https://dashscope-us.aliyuncs.com/*',
    'https://*.cn-beijing.maas.aliyuncs.com/*',
    'https://*.ap-southeast-1.maas.aliyuncs.com/*',
    'https://*.us-east-1.maas.aliyuncs.com/*',
    'https://*.eu-central-1.maas.aliyuncs.com/*',
    'https://mt.cn-hangzhou.aliyuncs.com/*',
  ],
  optional_host_permissions: ['https://*/*', 'http://*/*'],
  background: { service_worker: 'background.js', type: 'module' },
  action: { default_title: '页伴翻译', default_popup: 'popup.html' },
  options_page: 'options.html',
  side_panel: { default_path: 'sidepanel.html' },
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
};
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await cp(resolve(root, 'public/icons'), resolve(outDir, 'icons'), { recursive: true });
console.log('页伴翻译构建完成：dist/');
