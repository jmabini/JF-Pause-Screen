#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    tool: null,
    now: null,
    next: [],
    blocks: null,
    confidence: null,
    file: 'PROJECT_CONTEXT.md',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tool') args.tool = argv[++i] ?? null;
    else if (arg === '--now') args.now = argv[++i] ?? null;
    else if (arg === '--next') args.next.push(argv[++i] ?? '');
    else if (arg === '--blocks') args.blocks = argv[++i] ?? null;
    else if (arg === '--confidence') args.confidence = argv[++i] ?? null;
    else if (arg === '--file') args.file = argv[++i] ?? args.file;
    else if (arg === '-h' || arg === '--help') args.help = true;
    else throw new Error(`Unknown arg: ${arg}`);
  }

  args.next = args.next.filter(Boolean).slice(0, 3);
  return args;
}

function usage() {
  return [
    'Update PROJECT_CONTEXT.md digest + session snapshot fields.',
    '',
    'Usage:',
    '  node scripts/update_project_context.mjs --tool Codex',
    '  node scripts/update_project_context.mjs --tool Antigravity --now "Fixing X"',
    '',
    'Options:',
    '  --tool <Codex|Antigravity>   Set active tool (optional)',
    '  --now <text>                Update digest now + Current Status (optional)',
    '  --next <text>               Add next-step item (repeatable, max 3)',
    '  --blocks <text>             Update digest blocks (optional)',
    '  --confidence <High|Medium|Low> Update digest confidence + snapshot (optional)',
    '  --file <path>               Defaults to PROJECT_CONTEXT.md',
  ].join('\n');
}

function tryExec(args, options = {}) {
  try {
    // Use trimEnd() to preserve leading whitespace (important for parsing e.g. `git status --porcelain`).
    return execFileSync(args[0], args.slice(1), { encoding: 'utf8', ...options }).trimEnd();
  } catch {
    return null;
  }
}

function getGitContext() {
  const branch = tryExec(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = tryExec(['git', 'status', '--porcelain']);
  const isDirty = Boolean(porcelain && porcelain.length > 0);

  const modifiedFiles = (porcelain ?? '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  return {
    branch: branch ?? '<branch>',
    dirty: isDirty ? 'dirty' : 'clean',
    modifiedFiles: modifiedFiles.slice(0, 5),
  };
}

function readPackageVersion(repoRoot) {
  const pkgPath = path.join(repoRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return String(pkg.version || '').trim();
}

function readConfigVersion(repoRoot) {
  const configPath = path.join(repoRoot, 'src', 'config.js');
  const text = fs.readFileSync(configPath, 'utf8');
  const match = text.match(/\bversion:\s*['"]([^'"]+)['"]/);
  return match?.[1]?.trim() ?? '';
}

function readPackageLockVersion(repoRoot) {
  const lockPath = path.join(repoRoot, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  return String(lock.version || '').trim();
}

function assertVersionsMatch(pkgVersion, configVersion, lockVersion) {
  if (!pkgVersion) throw new Error('Could not determine version from package.json');
  if (!configVersion) throw new Error('Could not determine version from src/config.js');
  if (!lockVersion) throw new Error('Could not determine version from package-lock.json');
  if (pkgVersion !== configVersion || pkgVersion !== lockVersion) {
    throw new Error(
      `Version mismatch: package.json=${pkgVersion} vs src/config.js=${configVersion} vs package-lock.json=${lockVersion}. Fix versions before updating context.`
    );
  }
}

function extractBlock(text, startMarker, endMarker) {
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;
  const before = text.slice(0, startIdx);
  const block = text.slice(startIdx, endIdx + endMarker.length);
  const after = text.slice(endIdx + endMarker.length);
  return { before, block, after, startIdx, endIdx };
}

function parseDigestMap(digestBlock) {
  const lines = digestBlock.split('\n');
  const map = new Map();
  for (const line of lines) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

function formatMods(modifiedFiles) {
  if (!modifiedFiles.length) return '(none)';
  return modifiedFiles.join(', ');
}

function buildNextLine(nextItems, existingNextRaw) {
  if (!nextItems.length) return existingNextRaw ?? '1) <!-- ... --> 2) <!-- ... --> 3) <!-- ... -->';
  const items = nextItems.slice(0, 3);
  const padded = [items[0], items[1] ?? '...', items[2] ?? '...'];
  return `1) ${padded[0]} 2) ${padded[1]} 3) ${padded[2]}`;
}

function normalizeTool(tool) {
  if (!tool) return null;
  const normalized = tool.trim();
  if (normalized !== 'Codex' && normalized !== 'Antigravity') {
    throw new Error(`Invalid --tool value: ${tool} (expected Codex or Antigravity)`);
  }
  return normalized;
}

function normalizeConfidence(confidence) {
  if (!confidence) return null;
  const normalized = confidence.trim();
  if (normalized !== 'High' && normalized !== 'Medium' && normalized !== 'Low') {
    throw new Error(`Invalid --confidence value: ${confidence} (expected High, Medium, or Low)`);
  }
  return normalized;
}

function updateDigestBlock(originalDigest, updates) {
  const startMarker = '<!-- CONTEXT_DIGEST_START -->';
  const endMarker = '<!-- CONTEXT_DIGEST_END -->';
  const extracted = extractBlock(originalDigest, startMarker, endMarker);
  if (!extracted) throw new Error('Digest markers not found in PROJECT_CONTEXT.md');

  const map = parseDigestMap(extracted.block);

  map.set('version', updates.versionLine);
  if (updates.tool) map.set('tool', updates.tool);
  map.set('branch', updates.branch);
  map.set('dirty', updates.dirty);
  map.set('mods', updates.modsLine);

  if (updates.now) map.set('now', updates.now);
  if (updates.blocks) map.set('blocks', updates.blocks);
  if (updates.confidence) map.set('confidence', updates.confidence);
  map.set('next', buildNextLine(updates.nextItems, map.get('next')));

  const digestLines = extracted.block.split('\n').map((line) => {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) return line;
    const key = m[1];
    if (!map.has(key)) return line;
    return `${key}: ${map.get(key)}`;
  });

  return extracted.before + digestLines.join('\n') + extracted.after;
}

function replaceLine(text, prefix, value) {
  const lines = text.split('\n');
  let changed = false;
  const out = lines.map((line) => {
    if (line.startsWith(prefix)) {
      changed = true;
      return `${prefix}${value}`;
    }
    return line;
  });
  return { text: out.join('\n'), changed };
}

function updateSessionSnapshot(longForm, updates) {
  // Only touch the bullet values; leave prose and other sections untouched.
  let out = longForm;

  if (updates.tool) {
    out = replaceLine(out, '- Last Active Tool: ', updates.tool).text;
  }

  if (updates.now) {
    out = replaceLine(out, '- Current Status: ', updates.now).text;
  }

  out = replaceLine(out, '- Active Branch: ', updates.branch).text;
  out = replaceLine(out, '- Working Tree: ', updates.workingTree).text;

  // Update Current Version backtick content but keep the rest of the line.
  out = out.replace(
    /- Current Version: `[^`]+`/g,
    `- Current Version: \`${updates.version}\``
  );

  if (updates.confidence) {
    out = replaceLine(out, '- Confidence Level: ', updates.confidence).text;
  }

  // Replace the Key Modified Files list (the 3 example bullets) with actual files.
  const snapshotKey = '- Key Modified Files (if any):';
  const lines = out.split('\n');
  const idx = lines.findIndex((l) => l.trim() === snapshotKey);
  if (idx !== -1) {
    const before = lines.slice(0, idx + 1);
    let endIdx = idx + 1;
    while (endIdx < lines.length && lines[endIdx].startsWith('  - ')) endIdx += 1;
    const after = lines.slice(endIdx);

    const fileLines =
      updates.modifiedFiles.length > 0
        ? updates.modifiedFiles.map((f) => `  - ${f}`)
        : ['  - (none)'];

    out = [...before, ...fileLines, ...after].join('\n');
  }

  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const tool = normalizeTool(args.tool);
  const confidence = normalizeConfidence(args.confidence);

  const repoRoot = process.cwd();
  const git = getGitContext();
  const pkgVersion = readPackageVersion(repoRoot);
  const configVersion = readConfigVersion(repoRoot);
  const lockVersion = readPackageLockVersion(repoRoot);
  assertVersionsMatch(pkgVersion, configVersion, lockVersion);

  const filePath = path.resolve(repoRoot, args.file);
  const original = fs.readFileSync(filePath, 'utf8');

  const digestMarkerStart = '<!-- CONTEXT_DIGEST_START -->';
  const digestMarkerEnd = '<!-- CONTEXT_DIGEST_END -->';
  const digestExtract = extractBlock(original, digestMarkerStart, digestMarkerEnd);
  if (!digestExtract) throw new Error('Digest markers not found. Expected CONTEXT_DIGEST_START/END.');

  const updates = {
    tool,
    branch: git.branch,
    dirty: git.dirty,
    workingTree: git.dirty === 'dirty' ? 'Dirty' : 'Clean',
    modifiedFiles: git.modifiedFiles,
    modsLine: formatMods(git.modifiedFiles),
    version: pkgVersion,
    versionLine: `${pkgVersion} (must match package.json, package-lock.json, src/config.js)`,
    now: args.now,
    nextItems: args.next,
    blocks: args.blocks,
    confidence,
  };

  let updated = updateDigestBlock(original, updates);

  // Update long-form session snapshot inside the <details> section.
  const detailsStart = '<details>';
  const detailsEnd = '</details>';
  const details = extractBlock(updated, detailsStart, detailsEnd);
  if (!details) throw new Error('Expected <details> block not found in PROJECT_CONTEXT.md');

  const updatedDetails = updateSessionSnapshot(details.block, updates);
  updated = details.before + updatedDetails + details.after;

  if (updated !== original) {
    // Token budget guardrail: digest should stay small (markers included).
    const digestNow = extractBlock(updated, digestMarkerStart, digestMarkerEnd);
    if (!digestNow) throw new Error('Digest markers vanished during update');
    const digestLineCount = digestNow.block.split('\n').length;
    if (digestLineCount > 25) {
      throw new Error(`Digest too large: ${digestLineCount} lines (max 25).`);
    }

    fs.writeFileSync(filePath, updated, 'utf8');
    process.stdout.write(`Updated ${path.relative(repoRoot, filePath)}\n`);
  } else {
    process.stdout.write(`No changes needed for ${path.relative(repoRoot, filePath)}\n`);
  }
}

main();
