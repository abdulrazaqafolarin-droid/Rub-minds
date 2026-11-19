import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

function globSegmentToRegExp(segment) {
  let source = '';
  for (const character of segment) {
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else source += character.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
  }
  return new RegExp('^' + source + '$');
}

async function expandNodeTestPath(pattern) {
  const normalized = pattern.replaceAll('\\', '/');
  if (normalized.startsWith('/')) return [];
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return [];
  let candidates = [root];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const finalSegment = index === segments.length - 1;
    const wildcard = /[*?]/.test(segment);
    const next = [];
    for (const parent of candidates) {
      let names;
      if (wildcard) {
        try {
          names = await readdir(parent);
        } catch {
          continue;
        }
        const matcher = globSegmentToRegExp(segment);
        names = names.filter((name) => matcher.test(name));
      } else {
        names = [segment];
      }

      for (const name of names) {
        const candidate = resolve(parent, name);
        try {
          const info = await stat(candidate);
          if (finalSegment ? info.isFile() : info.isDirectory()) next.push(candidate);
        } catch {
          // Missing candidates are reported by the caller as unresolved patterns.
        }
      }
    }
    candidates = [...new Set(next)];
    if (candidates.length === 0) break;
  }
  return candidates;
}

function nodeTestReferences() {
  const references = [];
  for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
    if (!/^node --test(?:\s|$)/.test(command)) continue;
    for (const token of command.replace(/^node --test\s*/, '').split(/\s+/).filter(Boolean)) {
      if (token.startsWith('-')) continue;
      references.push({ script, path: token });
    }
  }
  return references;
}

test('every node --test path or glob referenced by any package script resolves', async () => {
  const references = nodeTestReferences();
  assert.ok(references.length > 0, 'At least one Node test suite must be registered.');
  const missing = [];
  for (const reference of references) {
    if ((await expandNodeTestPath(reference.path)).length === 0) missing.push(reference);
  }
  assert.deepEqual(missing, [], 'package scripts reference missing files or empty globs: ' + JSON.stringify(missing));
});

test('Android companion test glob resolves to the checked-in source-contract suite', async () => {
  const command = manifest.scripts?.['test:android-companion'];
  assert.equal(typeof command, 'string', 'Missing Android companion test command');
  const tokens = command.replace(/^node --test\s*/, '').split(/\s+/).filter(Boolean);
  assert.equal(tokens.length, 1, 'Android companion test command must contain exactly one path/glob');
  const resolved = await expandNodeTestPath(tokens[0]);
  assert.ok(
    resolved.includes(resolve(root, 'android-companion/scripts/manifest-policy.node-test.mjs')),
    'Android companion glob must include manifest-policy.node-test.mjs'
  );
});

test('critical Backroom test suites remain registered in runtime and queue scripts', () => {
  const required = {
    'test:runtime': [
      'integrations/backroom/host-wake-service.node-test.mjs',
      'integrations/backroom/host-identity.node-test.mjs',
      'integrations/backroom/multi-surface-execution.node-test.mjs'
    ],
    'test:backroom': [
      'integrations/backroom/host-server.node-test.mjs',
      'integrations/backroom/multi-surface-execution.node-test.mjs'
    ],
    'test:durable-queue': [
      'integrations/backroom/host-wake-service.node-test.mjs',
      'integrations/backroom/host-identity.node-test.mjs'
    ]
  };
  for (const [name, paths] of Object.entries(required)) {
    const command = manifest.scripts?.[name];
    assert.equal(typeof command, 'string', 'Missing package script ' + name);
    for (const path of paths) assert.ok(command.includes(path), name + ' must include ' + path);
  }
});

test('focused Backroom test commands cover multi-surface and hosted lifecycle contracts', () => {
  const multi = manifest.scripts?.['test:multi-surface'];
  assert.equal(typeof multi, 'string', 'Missing focused multi-surface test command');
  for (const path of [
    'integrations/backroom/multi-surface-execution.node-test.mjs',
    'integrations/backroom/native-accessibility-adapter.node-test.mjs',
    'integrations/backroom/terminal-draft-adapter.node-test.mjs'
  ]) assert.ok(multi.includes(path), 'test:multi-surface must include ' + path);

  const lifecycle = manifest.scripts?.['test:host-lifecycle'];
  assert.equal(typeof lifecycle, 'string', 'Missing focused host lifecycle test command');
  for (const path of [
    'integrations/backroom/host-identity.node-test.mjs',
    'integrations/backroom/host-wake-service.node-test.mjs',
    'integrations/backroom/remote-wake-store.node-test.mjs'
  ]) assert.ok(lifecycle.includes(path), 'test:host-lifecycle must include ' + path);
});

test('host identity rotation is explicit and cannot be mistaken for server revocation', async () => {
  const wrapper = await readFile(resolve(root, 'scripts/backroom-host.mjs'), 'utf8');
  const server = await readFile(resolve(root, 'scripts/backroom-host-server.mjs'), 'utf8');
  const rotateCommand = manifest.scripts?.['backroom:rotate-host'];
  assert.equal(rotateCommand, 'node scripts/backroom-host.mjs --rotate-identity-only');
  assert.match(wrapper, /ambiguousRotate\s*=\s*process\.argv\.includes\("--rotate-identity"\)/);
  assert.match(wrapper, /Local rotation does not revoke a server host/);
  assert.match(server, /This only rotates the local file; it does NOT revoke the previous server registration/);
});
