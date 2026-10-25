// UPG-10: finds client-controllable path-like expressions in upstream server/
// code and compares them with the audited list in mydocs/04 section 2.
import fs from 'node:fs';
import path from 'node:path';

import { APP_ROOT } from '../config.mjs';

const PATTERN = /\b(req|request|body|data|message|msg|payload|options|clientOptions|context|input|params|query)\??\.[A-Za-z]*(path|Path|cwd|Cwd|dir|Dir|root|Root|fileName|FileName|githubUrl|GithubUrl)\b/g;
const DESTRUCTURE = /const \{[^}]*\b(projectPath|filePath|cwd|workspacePath|path|fileName|githubUrl)\b[^}]*\} = req\.(body|query)/g;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : walk(full);
    return /\.(ts|js)$/.test(entry.name) ? [full] : [];
  });
}

/** `file | expression` keys found in the code, with the first line number. */
export function scanUpstream() {
  const found = new Map();
  for (const file of walk(path.join(APP_ROOT, 'server'))) {
    const relative = path.relative(APP_ROOT, file);
    if (relative === path.join('server', 'shared', 'isolation.ts')) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      for (const match of line.matchAll(PATTERN)) {
        const key = `${relative} | ${match[0]}`;
        if (!found.has(key)) found.set(key, index + 1);
      }
      for (const match of line.matchAll(DESTRUCTURE)) {
        const key = `${relative} | req.${match[2]}.${match[1]}`;
        if (!found.has(key)) found.set(key, index + 1);
      }
    });
  }
  return found;
}

/** Audited `file | expression` keys from mydocs/04 (backticked cells of section 2). */
export function auditedKeys() {
  const doc = fs.readFileSync(path.join(APP_ROOT, 'mydocs', '04-上游文件改动清单.md'), 'utf8');
  const section = doc.split('## 2.')[1]?.split('\n## ')[0] ?? '';
  const keys = new Set();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4 || !cells[1].startsWith('`server/')) continue;
    const fileCell = cells[1].replace(/`/g, '');
    const files = fileCell.includes('*')
      ? walk(path.join(APP_ROOT, path.dirname(fileCell))).map((file) => path.relative(APP_ROOT, file)).filter((file) => new RegExp(`^${fileCell.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`).test(file))
      : [fileCell];
    const expressions = [...cells[2].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    // "`req.body` 解构出的 `projectPath`" is how a destructured field is written.
    if (/解构出的/.test(cells[2]) && expressions.length >= 2) expressions.push(`${expressions[0]}.${expressions[1]}`);
    for (const file of files) for (const expression of expressions) keys.add(`${file} | ${expression}`);
  }
  return keys;
}

export function findUnaudited() {
  const audited = auditedKeys();
  return [...scanUpstream()].filter(([key]) => !audited.has(key)).map(([key, line]) => {
    const [file, expression] = key.split(' | ');
    return { file, line, expression };
  });
}

/** resolveReadOnlyRootPath may only be called from the patched file-tree module. */
export function unexpectedReadOnlyCallers() {
  const allowed = new Set([path.join('server', 'shared', 'utils.ts'), path.join('server', 'shared', 'types.ts'), path.join('server', 'modules', 'file-tree', 'file-tree.module.ts'), path.join('server', 'modules', 'file-tree', 'file-tree.service.ts')]);
  return walk(path.join(APP_ROOT, 'server'))
    .filter((file) => fs.readFileSync(file, 'utf8').includes('resolveReadOnlyRootPath'))
    .map((file) => path.relative(APP_ROOT, file))
    .filter((file) => !allowed.has(file));
}
