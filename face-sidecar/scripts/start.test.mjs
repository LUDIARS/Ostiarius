import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runtimeCommand } from './start.mjs';

test('launches module in a dedicated environment with loopback binding', () => {
  const command = runtimeCommand('/service with spaces', 'win32', '17591', () => true);
  assert.match(command.python.replaceAll('\\', '/'), /\.venv\/Scripts\/python.exe$/);
  assert.deepEqual(command.args, ['-m', 'uvicorn', 'face_sidecar.app:app', '--host', '127.0.0.1', '--port', '17591']);
  assert.match(runtimeCommand('/service', 'linux', '17591', () => true).python.replaceAll('\\', '/'), /\.venv\/bin\/python$/);
});

test('rejects missing environment and invalid port without starting a process', () => {
  assert.throws(() => runtimeCommand('/service', 'win32', '17591', () => false), /runtime missing/);
  for (const port of ['', '0', '65536', '17591 --host 0.0.0.0']) {
    assert.throws(() => runtimeCommand('/service', 'win32', port, () => true), /assigned port/);
  }
});
