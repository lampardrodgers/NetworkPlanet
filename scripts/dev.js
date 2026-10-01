// 同时启动 Hub（node --watch）和 Vite 开发服务器，Ctrl+C 一起退出。
import { spawn } from 'node:child_process';

const procs = [
  ['hub', 'npm', ['run', 'dev:server']],
  ['web', 'npm', ['run', 'dev:web']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const prefix = name === 'hub' ? '\x1b[36m[hub]\x1b[0m ' : '\x1b[35m[web]\x1b[0m ';
  const pipe = (stream, out) =>
    stream.on('data', (d) => out.write(d.toString().replace(/^(?=.)/gm, prefix)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${prefix}退出 (${code})`);
    shutdown(code ?? 0);
  });
  return p;
});

function shutdown(code = 0) {
  for (const p of procs) if (p.exitCode == null) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
