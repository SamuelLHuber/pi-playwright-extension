import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const root = fileURLToPath(new URL('../', import.meta.url));
const hostPackages = ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', '@mariozechner/pi-agent-core', '@mariozechner/pi-ai', '@mariozechner/pi-coding-agent', '@mariozechner/pi-tui', '@sinclair/typebox', 'typebox'];

test('host packages are wildcard peers, never runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const name of hostPackages) assert.equal(manifest.dependencies?.[name], undefined, name);
  for (const name of ['@earendil-works/pi-coding-agent', '@sinclair/typebox']) assert.equal(manifest.peerDependencies[name], '*', name);
});

test('actual resource-loader manifest diagnostics reject the old layout and accept this package', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-manifest-'));
  try {
    const bad = join(cwd, 'bad');
    mkdirSync(bad);
    writeFileSync(join(bad, 'package.json'), JSON.stringify({ name: 'bad-fixture', dependencies: { '@sinclair/typebox': '*' }, pi: { extensions: ['./index.ts'] } }));
    writeFileSync(join(bad, 'index.ts'), 'export default function () {}');
    const load = async (source: string) => {
      const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory({ packages: [source] }), noSkills: true, noContextFiles: true, noPromptTemplates: true });
      await loader.reload();
      return loader.getExtensions();
    };
    const rejected = await load(bad);
    assert.deepEqual(rejected.errors, []);
    assert.ok(rejected.warnings?.some(item => item.warning.includes('@sinclair/typebox')));
    const accepted = await load(root);
    assert.deepEqual(accepted.errors, []);
    assert.deepEqual(accepted.warnings ?? [], []);
    assert.ok(accepted.extensions.some(extension => extension.tools.has('browser_navigate')));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
