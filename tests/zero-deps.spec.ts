import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { PACKAGE_ROOT } from './support/reports.js';

/**
 * The authoritative zero-runtime-dependency proof - not the ESLint rule in
 * eslint.config.mjs (best-effort static linting on SOURCE), but the actual
 * BUILT output. A bare import cannot hide here: this is exactly what a
 * consumer's `node_modules` resolution would have to satisfy.
 */

function listJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listJsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;

/** Strip comments before scanning - a doc comment can legitimately mention a
 *  bare specifier as PROSE (e.g. reporter.ts explains why importing
 *  '@playwright/test/reporter' as a TYPE is safe), which would otherwise
 *  read as a real import. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test.describe('zero runtime dependencies - proven against the built dist/', () => {
  const distDir = path.join(PACKAGE_ROOT, 'dist');

  test('dist exists (run `npm run build` first)', () => {
    expect(() => readdirSync(distDir)).not.toThrow();
  });

  test('every import in every built file is a node: builtin or a relative path', () => {
    const files = listJsFiles(distDir);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      for (const match of source.matchAll(IMPORT_RE)) {
        const specifier = match[1];
        const isNodeBuiltin = specifier.startsWith('node:');
        const isRelative =
          specifier.startsWith('.') || specifier.startsWith('/');
        if (!isNodeBuiltin && !isRelative) {
          offenders.push(
            `${path.relative(PACKAGE_ROOT, file)}: "${specifier}"`
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('package.json declares no runtime dependencies', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8')
    ) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toBeUndefined();
  });

  test('package.json declares @playwright/test as an OPTIONAL peer dependency, not a hard one', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8')
    ) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(pkg.peerDependencies?.['@playwright/test']).toBeDefined();
    expect(pkg.peerDependenciesMeta?.['@playwright/test']?.optional).toBe(true);
  });
});
