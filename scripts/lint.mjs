#!/usr/bin/env node
/**
 * Project policy linter.
 *
 * This is not a general-purpose JavaScript linter. It enforces the rules this
 * repository decided on, which are the rules a type checker cannot express and
 * that a reviewer should not have to catch by eye every time:
 *
 *   1. Package layering. packages/* must never import from apps/*.
 *   2. Cross-package imports must use the declared package name, never a deep
 *      relative path into another package.
 *   3. Pure layers (domain, storage) must not write to the console.
 *   4. Tests must not be silently disabled with .only, .skip or .todo.
 *   5. No @ts-ignore. @ts-expect-error is allowed only with a justification.
 *   6. No `any` in application source.
 *   7. No literal credential-shaped strings in tracked source.
 *   8. The engine sandbox must never be configured as danger-full-access in
 *      committed configuration.
 *
 * Every rule points at the specification or architecture section it protects.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.shiploop-dev', 'coverage', 'test-results', 'playwright-report']);
const PURE_PACKAGES = new Set(['packages/domain', 'packages/storage']);

const findings = [];

function report(file, line, rule, message) {
  findings.push({ file: relative(root, file), line, rule, message });
}

async function walk(dir, files = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.shiploop') {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
    }
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else files.push(path);
  }
  return files;
}

function ownerPackage(file) {
  const parts = relative(root, file).split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

function isTestFile(file) {
  return /\.(test|spec)\.(ts|tsx)$/.test(file);
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension));
}

const rules = [
  {
    id: 'layering/no-app-import',
    applies: (file) => ownerPackage(file)?.startsWith('packages/') ?? false,
    check(line, file, lineNumber) {
      const match = /from\s+['"]([^'"]+)['"]/.exec(line);
      if (!match) return;
      if (/apps\//.test(match[1]) || /@shiploop\/(web|worker)/.test(match[1])) {
        report(file, lineNumber, 'layering/no-app-import', `packages must not import from apps (${match[1]}).`);
      }
      if (match[1].startsWith('@shiploop/') && match[1].includes('/')) {
        report(file, lineNumber, 'layering/no-deep-import', `Import another package by its root name, not ${match[1]}.`);
      }
    },
  },
  {
    id: 'pure/no-console',
    applies: (file) => PURE_PACKAGES.has(ownerPackage(file) ?? ''),
    check(line, file, lineNumber) {
      if (/\bconsole\.(log|info|debug|warn|error|trace)\s*\(/.test(line)) {
        report(file, lineNumber, 'pure/no-console', 'Pure layers must not write to the console; return typed results instead.');
      }
    },
  },
  {
    id: 'tests/no-disabled',
    applies: (file) => isTestFile(file),
    check(line, file, lineNumber) {
      if (/\b(it|test|describe)\.only\s*\(/.test(line)) {
        report(file, lineNumber, 'tests/no-disabled', 'Focused tests hide the rest of the suite.');
      }
      if (/\b(it|test|describe)\.(skip|todo)\s*\(/.test(line)) {
        report(file, lineNumber, 'tests/no-disabled', 'A skipped check is not a passed check (mvp-spec F20-AC2).');
      }
    },
  },
  {
    id: 'types/no-ts-ignore',
    applies: (file) => isSourceFile(file),
    check(line, file, lineNumber) {
      if (/@ts-ignore\b/.test(line)) {
        report(file, lineNumber, 'types/no-ts-ignore', '@ts-ignore suppresses errors silently; fix the type instead.');
      }
      if (/@ts-expect-error\b/.test(line) && !/@ts-expect-error\s+\S/.test(line)) {
        report(file, lineNumber, 'types/no-ts-ignore', '@ts-expect-error needs a justification comment after it.');
      }
    },
  },
  {
    id: 'types/no-any',
    applies: (file) => isSourceFile(file) && !isTestFile(file),
    check(line, file, lineNumber) {
      if (/:\s*any\b|<any>|\bas\s+any\b|\bany\[\]/.test(line)) {
        report(file, lineNumber, 'types/no-any', 'Explicit any erases the type boundary.');
      }
    },
  },
  {
    id: 'secrets/no-literals',
    applies: (file) => isSourceFile(file) || file.endsWith('.json'),
    check(line, file, lineNumber) {
      const patterns = [/\blin_(?:api|oauth)_[A-Za-z0-9]{8,}/, /\bgh[pousr]_[A-Za-z0-9]{16,}/, /\bsk-[A-Za-z0-9_-]{16,}/, /-----BEGIN[^-]*PRIVATE KEY-----/];
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          report(file, lineNumber, 'secrets/no-literals', 'Credential-shaped literal in tracked source (N02-AC2).');
        }
      }
    },
  },
  {
    id: 'engine/no-full-access',
    applies: (file) => /\.(json|jsonc|toml|ts)$/.test(file),
    check(line, file, lineNumber) {
      if (/danger-full-access/.test(line)) {
        report(file, lineNumber, 'engine/no-full-access', 'The coding engine sandbox must not be unrestricted (F03-AC5, N02-AC3).');
      }
    },
  },
];

const files = (await walk(root)).filter((file) => {
  const path = relative(root, file);
  if (path === 'pnpm-lock.yaml') return false;
  if (/\.(json|jsonc|toml)$/.test(file)) return true;
  if (!SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))) return false;
  return !path.startsWith('scripts/');
});

for (const file of files) {
  const contents = await readFile(file, 'utf8');
  const lines = contents.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.length > 2000) continue;
    for (const rule of rules) {
      if (!rule.applies(file)) continue;
      rule.check(line, file, index + 1);
    }
  }
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.packageManager !== 'pnpm@11.15.0') {
  findings.push({ file: 'package.json', line: 1, rule: 'toolchain/pnpm-pin', message: 'Preserve the explicit pnpm@11.15.0 pin.' });
}

const unique = [...new Map(findings.map((finding) => [`${finding.file}:${finding.line}:${finding.rule}`, finding])).values()].sort(
  (left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule),
);

for (const finding of unique) {
  console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
}
console.log(unique.length ? `Failed: ${unique.length} policy violation(s)` : 'Passed: project policy lint');
process.exitCode = unique.length ? 1 : 0;
