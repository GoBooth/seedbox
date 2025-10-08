import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

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

const buildVersion = computeBuildVersion();
console.log(`→ Using build version ${buildVersion}`);

const sharedEnv = {
  ...process.env,
  VITE_BUILD_VERSION: buildVersion,
};

run('npm install --prefix frontend --include=dev', sharedEnv);
run('npm run build --prefix frontend', sharedEnv);
