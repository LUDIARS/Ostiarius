// @implements spec/feature/face-runtime-readiness.md
// Excubitor owns service startup; this launcher owns its Python child.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function runtimeCommand(root, platform, port, exists = existsSync) {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Expected the Excubitor-assigned port (1..65535)');
  }
  const python = resolve(root, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!exists(python)) {
    throw new Error('Face runtime missing: provision face-sidecar/.venv and install face-sidecar dependencies first');
  }
  return { python, args: ['-m', 'uvicorn', 'face_sidecar.app:app', '--host', '127.0.0.1', '--port', port] };
}

export function start(port) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const command = runtimeCommand(root, process.platform, port);
  const child = spawn(command.python, command.args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false });
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  const cleanup = () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('exit', stop);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', stop);
  child.once('error', (error) => {
    cleanup();
    process.stderr.write(`Face runtime could not start: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    cleanup();
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { start(process.argv[2] ?? ''); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
