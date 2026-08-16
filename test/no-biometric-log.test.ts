import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('biometric privacy boundary', () => {
  it('does not log raw frames, embeddings, or full-name fields in the face domain', () => {
    const source = sourceFiles(join(process.cwd(), 'server', 'face')).map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(source).not.toMatch(/console\.(?:log|warn|error)\([^)]*(?:frame|embedding|template|image|name)/i);
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream/);
  });
});
