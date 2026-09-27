// webui/test/lib/agent-team-detect.test.js
// Unit tests for server/lib/agent-team-detect.js — pure helpers that
// parse the engine's `<task_result session_id="...">` body and detect
// when a subagent was dispatched.
//
// Coverage contract (every line is a documented claim from
// .tickets/webui-parity/06-agent-team-panel.md):
//
//   1. `parseTaskResult` extracts the child session id from the
//      `<task_result ... session_id="mvs_...">` literal — the engine's
//      only signal that a subagent row has been created.
//   2. The match is non-greedy and tolerates attribute ordering (other
//      attributes can come before or after session_id).
//   3. Optional `agent="..."` attribute is captured when present.
//   4. `isSubagentDispatch` recognises "task" / "Task" / "delegate" /
//      "delegatetask" / underscored variants — the engine has emitted
//      each of these in the wild (R8 investigation).
//   5. The header name is enough to start polling; the body tag is the
//      fallback when the webui attached mid-stream and the first frame
//      is the result body alone.
//   6. All helpers are read-only — a regression that added a write
//      would corrupt the runtime db and that is the kind of failure the
//      rule was written to prevent.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseTaskResult,
  isSubagentDispatch,
  AGENT_TEAM_STATUS,
} from "../../server/lib/agent-team-detect.js";

describe("parseTaskResult — extract child session id from tool body", () => {
  test("extracts session_id from a minimal tag", () => {
    const out = parseTaskResult(`<task_result session_id="mvs_deadbeef1234567890abcdef00000001"/>`);
    assert.ok(out);
    assert.equal(out.sessionId, "mvs_deadbeef1234567890abcdef00000001");
    assert.equal(out.agentName, null);
  });

  test("tolerates single-quoted attribute values", () => {
    const out = parseTaskResult(`<task_result session_id='mvs_abc'/>`);
    assert.ok(out);
    assert.equal(out.sessionId, "mvs_abc");
  });

  test("captures the agent hint when the engine inlines one", () => {
    const out = parseTaskResult(
      `<task_result session_id="mvs_aaa" agent="verifier"/>`,
    );
    assert.ok(out);
    assert.equal(out.sessionId, "mvs_aaa");
    assert.equal(out.agentName, "verifier");
  });

  test("tolerates attribute ordering — session_id first or last", () => {
    const first = parseTaskResult(
      `<task_result session_id="mvs_one" agent="explore" foo="bar"/>`,
    );
    const last = parseTaskResult(
      `<task_result agent="explore" foo="bar" session_id="mvs_two"/>`,
    );
    assert.equal(first.sessionId, "mvs_one");
    assert.equal(last.sessionId, "mvs_two");
  });

  test("non-greedy: the first `<task_result>` is what matters", () => {
    // Two tags back-to-back would otherwise bleed across; the regex
    // stops at the first closing `>`.
    const body = `<task_result session_id="mvs_first"/><task_result session_id="mvs_second"/>`;
    const out = parseTaskResult(body);
    assert.equal(out.sessionId, "mvs_first");
  });

  test("extracts the session id even when the body has prose around the tag", () => {
    const out = parseTaskResult(
      `Spawned worker:\n<task_result session_id="mvs_in_a_paragraph"/>\nDone.`,
    );
    assert.ok(out);
    assert.equal(out.sessionId, "mvs_in_a_paragraph");
  });

  test("returns null when the body does not contain a <task_result>", () => {
    assert.equal(parseTaskResult(""), null);
    assert.equal(parseTaskResult("plain text"), null);
    assert.equal(parseTaskResult(null), null);
    assert.equal(parseTaskResult(undefined), null);
    assert.equal(parseTaskResult(`<other session_id="x"/>`), null);
  });

  test("returns null when session_id is empty", () => {
    assert.equal(parseTaskResult(`<task_result session_id=""/>`), null);
    assert.equal(parseTaskResult(`<task_result session_id=''/>`), null);
  });

  test("trims whitespace from the captured id", () => {
    const out = parseTaskResult(`<task_result session_id="   mvs_padded   "/>`);
    assert.ok(out);
    assert.equal(out.sessionId, "mvs_padded");
  });
});

describe("isSubagentDispatch — header name + body fallback", () => {
  test("recognises the canonical 'task' header", () => {
    assert.equal(isSubagentDispatch("task", ""), true);
  });

  test("is case-insensitive", () => {
    assert.equal(isSubagentDispatch("Task", ""), true);
    assert.equal(isSubagentDispatch("TASK", ""), true);
  });

  test("recognises the 'delegate' / 'delegatetask' legacy variants", () => {
    assert.equal(isSubagentDispatch("delegate", ""), true);
    assert.equal(isSubagentDispatch("delegate_task", ""), true);
    assert.equal(isSubagentDispatch("Delegatetask", ""), true);
  });

  test("rejects unrelated tool names", () => {
    assert.equal(isSubagentDispatch("read", ""), false);
    assert.equal(isSubagentDispatch("bash", ""), false);
    assert.equal(isSubagentDispatch("write", ""), false);
    assert.equal(isSubagentDispatch("", ""), false);
  });

  test("the body tag is enough when the header name is missing", () => {
    // Mid-stream attach: the first frame is the body, no `→ name`
    // header yet. The presence of the tag itself is the signal.
    assert.equal(
      isSubagentDispatch(
        "",
        `<task_result session_id="mvs_orphan"/>`,
      ),
      true,
    );
  });

  test("rejects when neither header nor body tag match", () => {
    assert.equal(isSubagentDispatch("read", "nothing relevant"), false);
  });

  test("treats nullish inputs as no signal, never throws", () => {
    assert.equal(isSubagentDispatch(null, null), false);
    assert.equal(isSubagentDispatch(undefined, undefined), false);
    assert.equal(isSubagentDispatch(123, true), false);
  });
});

describe("re-exports — vocabulary surface", () => {
  test("AGENT_TEAM_STATUS is re-exported so a single import suffices", () => {
    assert.ok(AGENT_TEAM_STATUS);
    assert.equal(AGENT_TEAM_STATUS.RUNNING, "running");
  });
});
