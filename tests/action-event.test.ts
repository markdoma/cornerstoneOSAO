import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedActionDetail } from '../apps/widget/src/action-event.js';
test('completed action notification includes only scoped metadata', () => {
  assert.deepEqual(
    completedActionDetail(
      {
        type: 'orchestrator:action-completed',
        deploymentId: 'deployment',
        actionId: 'action_1',
        toolId: 'tool_1',
        apiToken: 'never-forward',
        arguments: { private: 'data' },
      },
      'deployment',
    ),
    { deploymentId: 'deployment', actionId: 'action_1', toolId: 'tool_1' },
  );
});
test('invalid or cross-deployment completion messages cannot trigger a host refresh', () => {
  const valid = {
    type: 'orchestrator:action-completed',
    deploymentId: 'deployment',
    actionId: 'action_1',
    toolId: 'tool_1',
  };
  for (const value of [
    null,
    [],
    {},
    { ...valid, deploymentId: 'other' },
    { ...valid, type: 'other' },
    { ...valid, toolId: 42 },
    { ...valid, actionId: 'x'.repeat(101) },
    { ...valid, actionId: '<script>' },
  ])
    assert.equal(completedActionDetail(value, 'deployment'), null);
});
