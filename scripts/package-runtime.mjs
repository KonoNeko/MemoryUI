import path from 'node:path';
import { cp, lstat, mkdir, readdir } from 'node:fs/promises';

const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.css']);
const PUBLIC_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2']);
const SKILL_EXTENSIONS = new Set(['.md', '.yaml', '.yml', '.mjs', '.js']);

async function copyFile(source, destination) {
  const details = await lstat(source);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Package source must be a regular file');
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { dereference: false });
}

async function copyTree(source, destination, extensions) {
  const details = await lstat(source);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Package directory must not be a symbolic link');
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name === 'artifacts') continue;
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not included in MemoryUI packages');
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, extensions);
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) await copyFile(from, to);
  }
}

// Deliberate allowlist: never copy the repository, .env, fixtures, artifacts,
// dependency trees or a user's runtime.json into a distributable.
export async function copyRuntime(sourceRoot, destination) {
  for (const filename of ['agent.mjs', 'server.mjs', 'index.html', 'package.json']) await copyFile(path.join(sourceRoot, filename), path.join(destination, filename));
  try { await copyFile(path.join(sourceRoot, 'mcp.mjs'), path.join(destination, 'mcp.mjs')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await copyTree(path.join(sourceRoot, 'src'), path.join(destination, 'src'), SOURCE_EXTENSIONS);
  await copyTree(path.join(sourceRoot, 'public'), path.join(destination, 'public'), PUBLIC_EXTENSIONS);
}

export async function copySkill(source, destination) {
  await copyFile(path.join(source, 'SKILL.md'), path.join(destination, 'SKILL.md'));
  for (const folder of ['agents', 'references', 'scripts']) {
    try { await copyTree(path.join(source, folder), path.join(destination, folder), SKILL_EXTENSIONS); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
