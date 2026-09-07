import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(resolve(root, 'dist/manifest.json'))) throw new Error('请先执行 npm run build。');
mkdirSync(resolve(root, 'release'), { recursive: true });
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本号格式不正确。');
// 只打包明确生成的 dist，避免把设置、源码或开发依赖带入安装包。
const python = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(python, ['-c', 'import pathlib,zipfile,sys; root=pathlib.Path("dist"); out=pathlib.Path("release")/("yeban-translate-"+sys.argv[1]+".zip"); z=zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(root)) for p in sorted(root.rglob("*")) if p.is_file()]; z.close(); print(out.resolve())', version], { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error(`打包失败：无法启动 ${python}。`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
