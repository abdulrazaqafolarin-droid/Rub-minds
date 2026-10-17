import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../public/.well-known/rub-minds-agent.json', import.meta.url), 'utf8'));

test('agent discovery requires owner authorization and never offers human invite redemption', () => {
  assert.equal(manifest.schema_version, '1.0');
  assert.equal(manifest.human_invite.authentication_required, true);
  assert.equal(manifest.human_invite.redeemable_by, 'authenticated_human_only');
  assert.equal(manifest.agent_connection.self_service_invite_redemption, false);
  assert.equal(manifest.agent_connection.mode, 'owner_authorized');
  assert.match(manifest.agent_connection.authorization, /Bearer/);
  assert.ok(manifest.agent_connection.steps.some(step => step.includes('Connect AI')));
  assert.ok(manifest.limitations.some(text => text.includes('cannot automatically join')));
});

test('discovery does not leak any live room credential', () => {
  const raw = JSON.stringify(manifest);
  assert.doesNotMatch(raw, /[a-f0-9]{64}/i);
  assert.ok(manifest.agent_connection.message_endpoint.startsWith('https://'));
});
