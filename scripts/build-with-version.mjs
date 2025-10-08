import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const DEV_VARS_PATH = resolve(projectRoot, '.dev.vars');

function hydrateDevVars() {
  if (!existsSync(DEV_VARS_PATH)) return;
  try {
    const content = readFileSync(DEV_VARS_PATH, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      let value = rawValue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (error) {
    console.warn('Unable to read .dev.vars file:', error);
  }
}

function run(command, extraEnv = {}) {
  execSync(command, {
    stdio: 'inherit',
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv },
  });
}

function computeBuildVersion() {
  try {
    const count = execSync('git rev-list --count HEAD', { cwd: projectRoot })
      .toString()
      .trim();
    const shortSha = execSync('git rev-parse --short HEAD', { cwd: projectRoot })
      .toString()
      .trim();
    return `0.${count}-${shortSha}`;
  } catch (error) {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    console.warn(
      'Unable to read git metadata. Falling back to timestamp-based version.',
      error,
    );
    return `0.${timestamp}`;
  }
}

hydrateDevVars();

const buildVersion = computeBuildVersion();
console.log(`→ Using build version ${buildVersion}`);

const sharedEnv = {
  ...process.env,
  VITE_BUILD_VERSION: buildVersion,
};

run('npm install --prefix frontend --include=dev', sharedEnv);
run('npm run build --prefix frontend', sharedEnv);
