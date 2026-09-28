// Probe that pins the round-3 B6.1 contract:
//   1. SIGTERM must kill the process with exit 143 (was 137 in round-2)
//   2. SIGINT  must kill the process with exit 130
//   3. residual tmpdir count = 0 in BOTH cases
//
// Usage:
//   node scripts/probe-signal-exit-code.mjs &  PID=$!
//   kill -TERM $PID ; wait $PID ; echo "TERM exit=$?"
//   kill -INT  $PID ; wait $PID ; echo "INT  exit=$?"
//
// NOT part of the published test suite — placed under scripts/ only so
// the helper import resolves (the script cannot live under archive/
// which is outside the repo). Round-3 acceptance copies it into the
// evidence directory for archival.
import { mkTmpDir } from "../packages/webui/test/helpers/tmp.js";

mkTmpDir("probe-signal-exit-");
console.log("started pid=" + process.pid);
setInterval(() => {}, 60000);
