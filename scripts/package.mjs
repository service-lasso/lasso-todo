import { cp, mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = JSON.parse(await readFile(path.join(root, 'service-build.json'), 'utf8'));
const platform = process.argv[2] ?? process.platform;
if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error('Unsupported platform');
await mkdir(path.join(root, '.tmp'), { recursive: true });
await mkdir(path.join(root, 'dist'), { recursive: true });
const stage = await mkdtemp(path.join(root, '.tmp', 'package-'));
await mkdir(path.join(stage, 'runtime'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
}
if (build.kind === 'node') {
  for (const name of ['server.mjs', 'index.html', 'database.mjs']) await cp(path.join(root, 'runtime', name), path.join(stage, 'runtime', name));
  await cp(path.join(root, 'node_modules'), path.join(stage, 'runtime', 'node_modules'), { recursive: true });
} else if (build.kind === 'go') {
  const executable = platform === 'win32' ? 'todo-api.exe' : 'todo-api';
  run('go', ['build', '-trimpath', '-o', path.join(stage, 'runtime', executable), '.'], {
    cwd: path.join(root, 'src'), env: { ...process.env, CGO_ENABLED: '0', GOOS: platform === 'win32' ? 'windows' : platform, GOARCH: 'amd64' }
  });
} else throw new Error('Unknown package kind');
await cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
const archive = path.join(root, 'dist', `${build.name}-${platform}.${platform === 'win32' ? 'zip' : 'tar.gz'}`);
if (platform === 'win32') {
  if (process.platform !== 'win32') throw new Error('Build the Windows ZIP on Windows');
  try { await unlink(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  run('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:LASSO_PACKAGE_STAGE, $env:LASSO_PACKAGE_ARCHIVE)'], {
    env: { ...process.env, LASSO_PACKAGE_STAGE: stage, LASSO_PACKAGE_ARCHIVE: archive }
  });
} else run('tar', ['-czf', archive, '-C', stage, '.']);
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', `${digest}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ platform, archive: path.basename(archive), sha256: digest }));
