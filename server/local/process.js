// 有界进程。不经本地 shell，不创建远端文件。
import { spawn } from 'node:child_process';
export function run(command, args, { signal, timeout = 20000, input, env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('已取消'));
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env || process.env });
    let out = '', err = '', why = '', timer, killTimer;
    const stop = reason => { why ||= reason; child.kill('SIGTERM'); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 1000); };
    const abort = () => stop('已取消');
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('测试超时'), timeout);
    child.stdout.on('data', d => { out += d; if (out.length > 100000) stop('输出超过上限'); });
    child.stderr.on('data', d => { err += d; if (err.length > 100000) stop('输出超过上限'); });
    const clean = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.on('error', e => { clean(); reject(new Error(e.code === 'ENOENT' ? `缺少本地工具：${command}` : '无法启动测量工具')); });
    child.on('close', code => { clean(); why ? reject(new Error(why)) : resolve({ code, out, err }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export async function workers(items, limit, fn, signal) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!signal?.aborted) {
      const i = cursor++;
      if (i >= items.length) break;
      await fn(items[i]);
    }
  }));
}
