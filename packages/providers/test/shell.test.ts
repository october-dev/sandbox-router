import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notAnOption, shellQuote } from '../src/shell.ts';

describe('notAnOption', () => {
  it('leaves ordinary paths alone and makes option-like ones relative', () => {
    expect(notAnOption('/home/user/a')).toBe('/home/user/a');
    expect(notAnOption('a/b')).toBe('a/b');
    expect(notAnOption('-delete')).toBe('./-delete');
  });

  it('keeps find from reading a directory name as an expression', () => {
    const root = mkdtempSync(join(tmpdir(), 'sr-shell-'));
    mkdirSync(join(root, '-delete'));
    writeFileSync(join(root, '-delete', 'keep'), 'x');
    const out = execFileSync('bash', ['-c', `find -H ${shellQuote(notAnOption('-delete'))} -mindepth 1 -maxdepth 1 -printf '%f\\n'`], {
      cwd: root,
    }).toString();
    expect(out.trim()).toBe('keep');
  });
});
