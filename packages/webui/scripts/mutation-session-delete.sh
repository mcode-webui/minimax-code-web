#!/usr/bin/env bash
# M4-3a — mutation proof for the session-delete retirement.
#
# Each mutation below is a ONE-LINE change to a real behaviour, reverted
# immediately after the run that is expected to go RED. The point is to
# show that the suite is not merely green but SENSITIVE: each of these
# re-introduces a specific mistake and names the test that catches it.
#
# Usage: bash scripts/mutation-session-delete.sh
# Requires: a built workspace (pnpm build) and pnpm installed.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"   # repo root
cd "${REPO_ROOT}"
WEBUI=packages/webui
# The runner's helper import is relative to packages/webui, so each case
# runs from there; every path below is written relative to that cwd.
RUNNER=(node --import tsx --import ./test/helpers/mavis-sources.mjs --experimental-test-module-mocks --test)

pass=0
fail=0

# run_case <label> <expecting-red-test-file> <mutation-command...>
run_case() {
  local label="$1"; shift
  local target="$1"; shift
  echo "── MUTATION: ${label}"
  if (cd "$WEBUI" && "$@") >/tmp/mut.log 2>&1; then
    echo "   ✗ NOT CAUGHT — the suite stayed green"
    fail=$((fail + 1))
  else
    if grep -q "${target}" /tmp/mut.log; then
      echo "   ✓ caught by ${target}"
      pass=$((pass + 1))
    else
      echo "   ✗ went red, but not on the expected assertion (${target})"
      tail -20 /tmp/mut.log
      fail=$((fail + 1))
    fi
  fi
  git checkout -- "${MUT_FILES[@]}" 2>/dev/null
}

MUT_FILES=()

# 1. The bare-SQL module comes back.
MUT_FILES=("$WEBUI/server/lib/mcode-session-delete.js")
cat > "$WEBUI/server/lib/mcode-session-delete.js" <<'EOF'
export function deleteMcodeSessionFromDb(sid) {
  return { ok: true, deleted: sid };
}
EOF
git add -f "$WEBUI/server/lib/mcode-session-delete.js" >/dev/null 2>&1
run_case "retired bare-SQL module reappears" "the retired module is really gone" \
  "${RUNNER[@]}" "test/lib/engine/session-delete-ownership.test.js"
# The resurrected module is NEW on disk (a checkout cannot remove it), so
# the generic revert cannot clean up after this one.
git rm -f --cached -q "$WEBUI/server/lib/mcode-session-delete.js" 2>/dev/null
rm -f "$WEBUI/server/lib/mcode-session-delete.js"

# 2. A second writer destroys engine rows behind the engine's back.
MUT_FILES=("$WEBUI/server/lib/sqlite-resolver.js")
cp "$WEBUI/server/lib/sqlite-resolver.js" /tmp/resolver.bak
cat >> "$WEBUI/server/lib/sqlite-resolver.js" <<'EOF'

// MUTATION (temporary): a second writer of the engine's own tables.
export function __mutationSweep(table, sid) {
  const Db = getMcodeBetterSqlite3();
  const db = new Db(process.env.MCODE_RUNTIME_DB);
  return db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sid);
}
EOF
run_case "a module deletes local_runtime_* rows directly" "issue DELETE statements" \
  "${RUNNER[@]}" "test/lib/engine/session-delete-ownership.test.js"
cp /tmp/resolver.bak "$WEBUI/server/lib/sqlite-resolver.js"

# 3. The data plane takes a WRITABLE handle on the engine's database.
MUT_FILES=("$WEBUI/server/engine/session-delete.js")
cp "$WEBUI/server/engine/session-delete.js" /tmp/plane.bak
python3 - <<'PY'
import re
p="packages/webui/server/engine/session-delete.js"
s=open(p,encoding="utf8").read()
s=s.replace("db = new Db(dbPath, { readonly: true });","db = new Db(dbPath);")
open(p,"w",encoding="utf8").write(s)
PY
run_case "the data plane opens the engine database for writing" "must open the engine database read-only" \
  "${RUNNER[@]}" "test/lib/engine/session-delete-ownership.test.js"
cp /tmp/plane.bak "$WEBUI/server/engine/session-delete.js"

# 4. The data plane deletes instead of asking the engine.
MUT_FILES=("$WEBUI/server/engine/session-delete.js")
python3 - <<'PY'
p="packages/webui/server/engine/session-delete.js"
s=open(p,encoding="utf8").read()
needle = ".prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE session_id = ?`)"
assert needle in s, "case 4 anchor not found"
s=s.replace(needle, needle + "\n      db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sid);")
open(p,"w",encoding="utf8").write(s)
PY
run_case "the data plane deletes rows itself" "data plane itself must not DELETE" \
  "${RUNNER[@]}" "test/lib/engine/session-delete-ownership.test.js"
cp /tmp/plane.bak "$WEBUI/server/engine/session-delete.js"

# 5. The facade stops reaching the data plane's engine entry point.
MUT_FILES=("$WEBUI/server/engine/session-writes.js")
cp "$WEBUI/server/engine/session-writes.js" /tmp/writes.bak
python3 - <<'PY'
p="packages/webui/server/engine/session-writes.js"
s=open(p,encoding="utf8").read()
s=s.replace("await deleter.deleteSessionThroughEngine(mcodeSid, {","await deleter.previewSessionDeleteRows(mcodeSid, {")
open(p,"w",encoding="utf8").write(s)
PY
run_case "the real delete is downgraded to a preview" "TRUE delete: re-deleting the same sid still reaches the engine" \
  "${RUNNER[@]}" "test/lib/engine/session-writes.test.js"
cp /tmp/writes.bak "$WEBUI/server/engine/session-writes.js"

# 6. The audit intent line moves AFTER the destructive step.
MUT_FILES=("$WEBUI/server/engine/session-delete.js")
cp "$WEBUI/server/engine/session-delete.js" /tmp/plane.bak
python3 - <<'PY'
p="packages/webui/server/engine/session-delete.js"
s=open(p,encoding="utf8").read()
intent = """  try {
    appendEvent("session.delete.intent", {
      target: sid,
      actor: "user",
      payload: { matchKind: "db", dryRun: false },
    });
  } catch (e) {
    return { ok: false, reason: "audit_write_failed", error: e.message };
  }

"""
assert intent in s
s = s.replace(intent, "")
s = s.replace("""  const outcome = count.totalRows > 0 ? "deleted" : "already_absent";""",
"""  try {
    appendEvent("session.delete.intent", {
      target: sid,
      actor: "user",
      payload: { matchKind: "db", dryRun: false },
    });
  } catch (e) {
    return { ok: false, reason: "audit_write_failed", error: e.message };
  }
  const outcome = count.totalRows > 0 ? "deleted" : "already_absent";""")
open(p,"w",encoding="utf8").write(s)
PY
run_case "the intent audit line lands after the delete" "the destructive step must find the intent line already written" \
  "${RUNNER[@]}" "test/lib/engine-session-delete-outcomes.test.js"
cp /tmp/plane.bak "$WEBUI/server/engine/session-delete.js"

# 7. A failed count is reported as a successful delete.
MUT_FILES=("$WEBUI/server/engine/session-delete.js")
cp "$WEBUI/server/engine/session-delete.js" /tmp/plane.bak
python3 - <<'PY'
p="packages/webui/server/engine/session-delete.js"
s=open(p,encoding="utf8").read()
s=s.replace("""  const count = _countSessionRows(sid, resolved);
  if (!count.ok) return count;""","""  const count = _countSessionRows(sid, resolved);
  if (!count.ok) {
    // MUTATION (temporary): treat an unreadable count as "nothing to delete".
    return { ok: true, outcome: "already_absent", log: [], totalRowsDeleted: 0, tablesAbsent: 0 };
  }""")
open(p,"w",encoding="utf8").write(s)
PY
run_case "a failed count reports success" "must NOT report success" \
  "${RUNNER[@]}" "test/lib/engine-session-delete-outcomes.test.js"
cp /tmp/plane.bak "$WEBUI/server/engine/session-delete.js"

# 8. The acp declaration keeps claiming the transport cannot delete.
MUT_FILES=("$WEBUI/server/engine/providers/acp.capabilities.js")
cp "$WEBUI/server/engine/providers/acp.capabilities.js" /tmp/acp.bak
python3 - <<'PY'
p="packages/webui/server/engine/providers/acp.capabilities.js"
s=open(p,encoding="utf8").read()
s=s.replace('missing: ["renameSession", "archiveSession"],','missing: ["deleteSession", "renameSession", "archiveSession"],')
open(p,"w",encoding="utf8").write(s)
PY
run_case "acp claims the transport still cannot delete" "the two absent session methods" \
  "${RUNNER[@]}" "test/lib/engine/capabilities.test.js"
cp /tmp/acp.bak "$WEBUI/server/engine/providers/acp.capabilities.js"

# 9. The preview loses a wire key.
MUT_FILES=("$WEBUI/server/engine/session-delete.js")
cp "$WEBUI/server/engine/session-delete.js" /tmp/plane.bak
python3 - <<'PY'
p="packages/webui/server/engine/session-delete.js"
s=open(p,encoding="utf8").read()
s=s.replace('return { ok: true, dryRun: true, log: count.log, totalRows: count.totalRows };',
            'return { ok: true, dryRun: true, log: count.log, totalRows: count.totalRows, tablesAffected: count.log.length };')
open(p,"w",encoding="utf8").write(s)
PY
run_case "the dryRun payload grows a key" "exactly {ok, dryRun, log, totalRows}" \
  "${RUNNER[@]}" "test/lib/engine-session-delete-outcomes.test.js"
cp /tmp/plane.bak "$WEBUI/server/engine/session-delete.js"

# 10. The order that prevents resurrection is broken: the engine is asked
#     before the ACP child is stopped.
MUT_FILES=("$WEBUI/server/engine/session-writes.js")
cp "$WEBUI/server/engine/session-writes.js" /tmp/writes.bak
python3 - <<'PY'
p="packages/webui/server/engine/session-writes.js"
s=open(p,encoding="utf8").read()
s=s.replace("""    mcodeDbDel = await deleter.deleteSessionThroughEngine(mcodeSid, {
      MCODE_RUNTIME_DB: config.MCODE_RUNTIME_DB,
    });""","""    mcodeDbDel = { ok: true, outcome: "deleted", log: [], totalRowsDeleted: 0 };
    void deleter;""")
open(p,"w",encoding="utf8").write(s)
PY
run_case "the delete stops calling the engine at all" "kill → SQL → scoped cache drop" \
  "${RUNNER[@]}" "test/lib/engine/session-writes.test.js"
cp /tmp/writes.bak "$WEBUI/server/engine/session-writes.js"

echo
echo "── MUTATION SUMMARY: ${pass} caught, ${fail} missed"
[ "${fail}" -eq 0 ]
