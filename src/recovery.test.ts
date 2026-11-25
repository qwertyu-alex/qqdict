import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFailure, failureCopy } from './recovery';

test('only temporary failures are retried automatically', () => {
  assert.equal(classifyFailure('The dictation connection closed before completion (code 1006).'), 'transient');
  assert.equal(classifyFailure('No final transcript arrived within 30 seconds.'), 'transient');
  assert.equal(classifyFailure('HTTP 503. The internal dictation route did not accept the connection.'), 'transient');
  assert.equal(classifyFailure('HTTP 429. The subscription dictation service has reached a usage limit.'), 'limit');
  assert.equal(classifyFailure('HTTP 401. Your existing Codex sign-in was not accepted.'), 'signin');
  assert.equal(classifyFailure('Sign in to Codex with ChatGPT, then reconnect. qqdict requires subscription sign-in.'), 'signin');
  assert.equal(classifyFailure('HTTP 403. This account or independent client is not allowed to use this dictation route.'), 'blocked');
  assert.equal(classifyFailure('No speech detected.'), 'silent');
  assert.equal(classifyFailure('The recording was interrupted before it was transcribed.'), 'interrupted');
});

test('island wording names the reason and the saved length', () => {
  assert.deepEqual(failureCopy('limit', 84.2), { title: 'Usage limit reached', detail: '1:24 saved · retry later' });
  assert.deepEqual(failureCopy('transient', 0.2), { title: 'Connection failed', detail: '0:01 saved' });
});
