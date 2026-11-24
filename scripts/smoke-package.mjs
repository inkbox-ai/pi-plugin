// Load the actual packed artifact, not a source checkout with dev dependencies.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = mkdtempSync(join(tmpdir(), 'inkbox-pi-smoke-'));
const pi = resolve('node_modules/.bin/pi');
const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1' };
let child;
try {
  const [artifact] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root]));
  execFileSync('npm', ['install', '--prefix', root, '--no-audit', '--no-fund', '--omit=peer',
    '--ignore-scripts', join(root, artifact.filename)], { stdio: 'inherit' });
  const installed = join(root, 'node_modules', '@inkbox', 'pi-plugin');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  execFileSync(pi, ['install', installed], { cwd: workspace, env, stdio: 'inherit' });
  child = spawn(pi, ['--mode', 'rpc', '--no-session'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const lines = createInterface({ input: child.stdout });
    child.stdin.write(JSON.stringify({ id: 'catalog-smoke', type: 'get_commands' }) + '\n');
    let commands;
    for await (const line of lines) {
      const response = JSON.parse(line);
      if (response.type !== 'response' || response.id !== 'catalog-smoke') continue;
      assert.equal(response.success, true);
      commands = response.data.commands;
      break;
    }
    assert.ok(commands?.some(command => command.name === 'inkbox-status' && command.source === 'extension'),
      'Installed extension must register the status command');
    assert.ok(commands.some(command => command.source === 'skill' && command.name.startsWith('skill:inkbox-')),
      'Installed package must expose its Inkbox skills');
  } finally {
    child.stdin.end();
    child.kill();
    await exited;
    clearTimeout(timeout);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
