'use strict';

const fs = require('fs');
const path = require('path');

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function validate(name, description, body) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'Skill name must be non-empty.' };
  }
  if (!description || typeof description !== 'string' || !description.trim()) {
    return { ok: false, error: 'Skill description must be non-empty.' };
  }
  if (description.includes('\n')) {
    return { ok: false, error: 'Skill description must be a single line.' };
  }
  if (description.includes('---')) {
    return { ok: false, error: 'Skill description must not contain "---" (breaks frontmatter).' };
  }
  if (!body || typeof body !== 'string' || !body.trim()) {
    return { ok: false, error: 'Skill body must be non-empty.' };
  }
  return { ok: true };
}

function create(name, description, body, outputDir) {
  const validation = validate(name, description, body);
  if (!validation.ok) return validation;

  const slug = slugify(name);
  const skillDir = path.join(outputDir, slug);
  const skillPath = path.join(skillDir, 'SKILL.md');

  if (fs.existsSync(skillPath)) {
    return { ok: false, error: `Skill "${slug}" already exists at ${skillPath}.` };
  }

  const content = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
    ''
  ].join('\n');

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, content, 'utf8');
  return { ok: true, path: skillPath };
}

function list(outputDir) {
  if (!outputDir || !fs.existsSync(outputDir)) {
    return { ok: true, output: 'No skills found.' };
  }

  let entries;
  try {
    entries = fs.readdirSync(outputDir, { withFileTypes: true });
  } catch {
    return { ok: true, output: 'No skills found.' };
  }

  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(outputDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, 'utf8');
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const descMatch = content.match(/^description:\s*(.+)$/m);
    skills.push({
      slug: entry.name,
      name: nameMatch ? nameMatch[1].trim() : entry.name,
      description: descMatch ? descMatch[1].trim() : '(no description)'
    });
  }

  if (!skills.length) {
    return { ok: true, output: 'No skills found.' };
  }

  const lines = ['Skills:', ''];
  for (const s of skills) {
    lines.push(`  ${s.name}`);
    lines.push(`    ${s.description}`);
    lines.push('');
  }
  return { ok: true, output: lines.join('\n') };
}

module.exports = { slugify, validate, create, list };

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  const dirIdx = args.indexOf('--dir');
  let outputDir;
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    outputDir = args[dirIdx + 1];
  } else {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    outputDir = path.join(cwd, '.claude', 'skills');
  }

  if (command === 'create') {
    const name = args[1];
    const description = args[2];
    const body = args[3];
    const result = create(name, description, body, outputDir);
    if (result.ok) {
      process.stdout.write(`Skill created at ${result.path}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } else if (command === 'list') {
    const result = list(outputDir);
    process.stdout.write(result.output + '\n');
  } else {
    process.stderr.write('Usage: node skill-scaffold.js <create|list> [args] [--dir path]\n');
    process.exit(1);
  }
}
