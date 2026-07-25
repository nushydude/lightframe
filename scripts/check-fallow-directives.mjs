import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const allowedRules = new Set(['complexity', 'unused-export']);
const sourceRoots = ['src', 'scripts'];
const files = [];

async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.worktrees') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(entryPath);
    else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) files.push(entryPath);
  }
}

for (const sourceRoot of sourceRoots) await collect(path.join(root, sourceRoot));
const directivePattern = /fallow-ignore-next-line\s+([a-z-]+)(?:\s+--\s+([^\n*]+))?/g;
for (const file of files) {
  const content = await fs.readFile(file, 'utf8');
  for (const match of content.matchAll(directivePattern)) {
    assert(allowedRules.has(match[1]), `Unknown Fallow rule '${match[1]}' in ${file}`);
    assert(match[2]?.trim(), `Fallow rule '${match[1]}' needs a reason in ${file}`);
  }
}
console.log(`validated Fallow directives in ${files.length} source files`);
