import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const pluginTarget = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'tavern-in-agy');

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Source path not found: ${src}`);
  }
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

console.log(`Installing TavernInAGY plugin to: ${pluginTarget}`);
fs.mkdirSync(pluginTarget, { recursive: true });

// Clean stale agents/skills before copying so renamed manifests never linger
for (const sub of ['agents', 'skills']) {
  const dir = path.join(pluginTarget, sub);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 1. Copy plugin manifests, skills, assets
copyRecursive(path.join(projectRoot, 'plugin'), pluginTarget);

// 2. Copy compiled dist/ (backend + singlefile UI)
const distSrc = path.join(projectRoot, 'dist');
if (!fs.existsSync(distSrc)) {
  console.error('Error: dist/ not found. Run `npm run build` first.');
  process.exit(1);
}
copyRecursive(distSrc, path.join(pluginTarget, 'dist'));

// 3. Copy package.json (for ESM "type": "module") and runtime node_modules
fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(pluginTarget, 'package.json'));

const nodeModulesTarget = path.join(pluginTarget, 'node_modules');
const nodeModulesSrc = path.join(projectRoot, 'node_modules');
if (!fs.existsSync(nodeModulesTarget) && fs.existsSync(nodeModulesSrc)) {
  try {
    fs.symlinkSync(nodeModulesSrc, nodeModulesTarget, 'junction');
    console.log('Linked node_modules via directory junction.');
  } catch {
    console.log('Symlink failed; copying node_modules...');
    copyRecursive(nodeModulesSrc, nodeModulesTarget);
  }
}

console.log('Done! TavernInAGY plugin is installed and ready for Antigravity.');
