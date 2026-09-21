import assert from 'node:assert/strict';
import test from 'node:test';

import { redactEvent, redactPayload, redactText, redactValue } from '../../server/trajectory/redact.mjs';

/**
 * Redaction of the encodings credentials actually take on disk.
 *
 * The earlier revision matched a key and its separator only when they were
 * adjacent. Real payloads are JSON, where a quote sits between the two —
 * `{"api_key":"…"}` — so the rule never fired and the value went out verbatim.
 * The same ordering bug ate the scheme word of an `Authorization: Bearer …`
 * header, leaving the token itself in the clear. Both are canaried here.
 *
 * Each case asserts the secret is gone *and* that the surrounding text survives:
 * a redactor that replaced everything would pass a one-sided assertion while
 * destroying the payload a reader needs.
 */

// Long enough to clear the minimum token length, and distinctive so a partial
// match is still detectable in the output.
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
const BASIC = 'dXNlcjpwYXNzd29yZA==';
const PLAIN = 'opaque-value-with-no-provider-prefix';

function assertGone(output, secret, label) {
  assert.equal(output.includes(secret), false, `${label} leaked: ${output}`);
}

function assertKept(output, fragment, label) {
  assert.equal(output.includes(fragment), true, `${label} destroyed the payload: ${output}`);
}

test('a JSON object keeps its shape while the value is redacted', () => {
  const out = redactText('{"api_key":"' + PLAIN + '"}');
  assertGone(out, PLAIN, 'JSON api_key');
  assertKept(out, '"api_key"', 'JSON api_key');
});

test('a nested JSON envelope is redacted at any depth', () => {
  const out = redactText('{"env":{"TOKEN":"' + PLAIN + '"}}');
  assertGone(out, PLAIN, 'JSON env.TOKEN');
  assertKept(out, '"env"', 'JSON env.TOKEN');
});

test('a JSON password field is redacted', () => {
  const out = redactText('{"password":"' + PLAIN + '"}');
  assertGone(out, PLAIN, 'JSON password');
});

test('a JSON secret field with padded spacing is redacted', () => {
  const out = redactText('{"secret":   "' + PLAIN + '"}');
  assertGone(out, PLAIN, 'JSON secret');
});

test('a single-quoted object literal is redacted', () => {
  const out = redactText("config = {'api_key': '" + PLAIN + "'}");
  assertGone(out, PLAIN, "single-quoted api_key");
  assertKept(out, 'config =', 'single-quoted api_key');
});

test('an Authorization header does not leave its bearer token behind', () => {
  const out = redactText(`Authorization: Bearer ${JWT}`);
  assertGone(out, JWT, 'Authorization: Bearer');
  assertKept(out, 'Authorization', 'Authorization: Bearer');
});

test('a Basic credential does not survive redaction', () => {
  const out = redactText(`authorization: Basic ${BASIC}`);
  assertGone(out, BASIC, 'authorization: Basic');
});

test('an Authorization header inside a shell command is redacted', () => {
  const out = redactText(`curl -H 'Authorization: Bearer ${JWT}' https://api.example.com`);
  assertGone(out, JWT, 'curl -H Authorization');
  assertKept(out, 'https://api.example.com', 'curl -H Authorization');
});

test('a proxy-authorization header is redacted', () => {
  const out = redactText(`proxy-authorization: Bearer ${JWT}`);
  assertGone(out, JWT, 'proxy-authorization');
});

test('provider-prefixed keys are still redacted', () => {
  for (const value of ['sk-live-abcdef1234567890', 'ghp_aaaaaaaaaaaaaaaaaaaa']) {
    assertGone(redactText(`export TOKEN=${value}`), value, 'provider key');
  }
});

test('the payload surrounding a secret is not destroyed', () => {
  const out = redactText('{"api_key":"' + PLAIN + '","count":3,"note":"keep me"}');
  assertKept(out, '"count":3', 'surrounding payload');
  assertKept(out, '"note":"keep me"', 'surrounding payload');
  assert.equal(JSON.parse(out).count, 3, 'the redacted text is still valid JSON');
});

test('ordinary text is left alone', () => {
  for (const text of ['nothing secret here', 'host: 127.0.0.1', '{"count":3}', 'turn-1 finished in 42ms']) {
    assert.equal(redactText(text), text, `over-redacted: ${text}`);
  }
});

test('the object form redacts secret-named keys without touching the rest', () => {
  const out = redactValue({ api_key: PLAIN, count: 3, note: 'keep me' });
  assert.equal(out.api_key, '[redacted]');
  assert.equal(out.count, 3);
  assert.equal(out.note, 'keep me');
});

test('a tool call description is redacted in full detail', () => {
  // events.mjs carries the background task's description onto the tool call, and
  // a bash task's description is its command line — the most likely place for an
  // inline credential.
  const event = {
    index: 1,
    toolCalls: [{
      name: 'bash',
      id: 'c1',
      description: `curl -H 'Authorization: Bearer ${JWT}' https://api.example.com`,
      args: { command: `export API_KEY=${PLAIN}` },
      result: 'ok',
    }],
  };
  const out = redactEvent(event, {});
  assertGone(out.toolCalls[0].description, JWT, 'toolCalls[].description');
  assertGone(out.toolCalls[0].args.command, PLAIN, 'toolCalls[].args.command');
  assertKept(out.toolCalls[0].description, 'https://api.example.com', 'toolCalls[].description');
  assert.equal(out.toolCalls[0].name, 'bash');
  assert.equal(out.toolCalls[0].result, 'ok');
});

test('a tool call result containing a credential is redacted in full detail', () => {
  const event = {
    index: 2,
    toolCalls: [{ name: 'read_file', id: 'c2', args: {}, result: `{"api_key":"${PLAIN}"}` }],
  };
  const out = redactEvent(event, {});
  assertGone(JSON.stringify(out), PLAIN, 'toolCalls[].result');
});

test('identifier-shaped keys survive the egress sweep', () => {
  // Caught in a browser, not by a unit test: key-name redaction was matching
  // `sessionId`, so `/api/sessions` returned `"sessionId": "[redacted]"` and every
  // subsequent request 404'd on a session that cannot exist. A session id is an
  // addressing token the Plugin prints and passes in URLs, not a bearer credential —
  // redacting it breaks the API rather than protecting anything.
  const payload = {
    sessionId: 'mvs_5b71cadfe7ec4eb2b38baaf0dab6a7fc',
    parentSessionId: 'mvs_parent',
    childSessionId: 'mvs_child',
    focusSessionId: 'mvs_focus',
    taskId: 'task-1',
    toolCallId: 'call-1',
    title: 'a title',
  };
  assert.deepEqual(redactPayload(payload), payload);
});

test('a cookie is a credential, but the envelope key named `session` is not', () => {
  // The other half of the same judgement call. `cookie` names a credential and keeps
  // the key-name rule. A bare `session` does not: it is the envelope field
  // `/api/overview` returns, and redacting it would blank the whole overview.
  assert.equal(redactValue({ cookie: PLAIN }).cookie, '[redacted]');
  const envelope = { session: { sessionId: 'mvs_abc', title: 'a title' }, stats: { turns: 3 } };
  assert.deepEqual(redactPayload(envelope), envelope);
});
