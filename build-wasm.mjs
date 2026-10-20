// Builds the Rust engine into wasm/text_engine.js and wasm/text_engine_bg.wasm.
// Works on Windows, macOS, and Linux. Run with: npm run build:wasm
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

function run(command, args) {
  // shell: true lets Windows find wasm-pack.cmd and cargo.exe on PATH.
  return spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: isWindows });
}

const check = spawnSync('wasm-pack', ['--version'], {
  cwd: root, stdio: 'ignore', shell: isWindows
});
if (check.error || check.status !== 0) {
  console.error('wasm-pack was not found on your PATH.');
  console.error('Install Rust from https://rustup.rs, then run: cargo install wasm-pack');
  console.error('Then close and reopen the terminal so PATH updates.');
  process.exit(1);
}

const build = run('wasm-pack', [
  'build', 'rust-engine',
  '--target', 'web',
  '--release',
  '--out-dir', '../wasm',
  '--out-name', 'text_engine'
]);
if (build.status !== 0) {
  console.error('wasm-pack build failed. See the errors above.');
  process.exit(build.status || 1);
}

for (const file of ['wasm/text_engine.js', 'wasm/text_engine_bg.wasm']) {
  if (!existsSync(join(root, file))) {
    console.error(`Build finished but ${file} is missing.`);
    process.exit(1);
  }
}
console.log('WASM build complete: wasm/text_engine.js and wasm/text_engine_bg.wasm');
