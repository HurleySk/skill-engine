'use strict';

const fs = require('fs');
const path = require('path');

function analyzersDir(projectDir) {
  return path.join(projectDir, '.claude', 'skills', 'analyzers');
}

function validate(body) {
  if (!body || typeof body !== 'string' || !body.trim()) {
    return { ok: false, error: 'Analyzer body must be non-empty.' };
  }
  if (!/exports\.analyze|module\.exports\.analyze/.test(body)) {
    return { ok: false, error: 'Analyzer must export an analyze function (exports.analyze or module.exports.analyze).' };
  }
  return { ok: true };
}

function create(name, body, projectDir) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'Analyzer name must be non-empty.' };
  }
  if (/[/\\]|\.\./.test(name)) {
    return { ok: false, error: 'Analyzer name must not contain path separators or "..".' };
  }

  const validation = validate(body);
  if (!validation.ok) return validation;

  const dir = analyzersDir(projectDir);
  const filePath = path.join(dir, name + '.js');

  if (fs.existsSync(filePath)) {
    return { ok: false, error: `Analyzer "${name}" already exists at ${filePath}.` };
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
  return { ok: true, path: filePath };
}

function list(projectDir) {
  const dir = analyzersDir(projectDir);

  if (!fs.existsSync(dir)) {
    return { ok: true, output: 'No analyzers found.' };
  }

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { ok: true, output: 'No analyzers found.' };
  }

  const analyzers = [];
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    const filePath = path.join(dir, entry);
    const content = fs.readFileSync(filePath, 'utf8');
    const firstLine = content.split('\n')[0];
    const commentMatch = firstLine.match(/^\/\/\s*(.+)/);
    analyzers.push({
      name: entry.replace(/\.js$/, ''),
      description: commentMatch ? commentMatch[1].trim() : '(no description)'
    });
  }

  if (!analyzers.length) {
    return { ok: true, output: 'No analyzers found.' };
  }

  const lines = ['Analyzers:', ''];
  for (const a of analyzers) {
    lines.push(`  ${a.name}`);
    lines.push(`    ${a.description}`);
    lines.push('');
  }
  return { ok: true, output: lines.join('\n') };
}

module.exports = { validate, create, list };

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  const dirIdx = args.indexOf('--dir');
  let projectDir;
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    projectDir = args[dirIdx + 1];
  } else {
    projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }

  if (command === 'create') {
    const name = args[1];
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', () => {
      const result = create(name, body, projectDir);
      if (result.ok) {
        process.stdout.write(`Analyzer created at ${result.path}\n`);
      } else {
        process.stderr.write(`Error: ${result.error}\n`);
        process.exit(1);
      }
    });
  } else if (command === 'list') {
    const result = list(projectDir);
    process.stdout.write(result.output + '\n');
  } else {
    process.stderr.write('Usage: node analyzer-scaffold.js <create|list> [args] [--dir path]\n');
    process.exit(1);
  }
}
