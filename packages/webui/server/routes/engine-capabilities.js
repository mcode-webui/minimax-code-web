// webui/server/routes/engine-capabilities.js
// GET /api/engine-capabilities — the engine capability declaration
// endpoint (engine-abstraction batch B1).
//
// Returns the 14-key declaration for one engine provider plus the
// degradation summary the frontend will render from (batch B1 computes
// it; the capability-driven UI itself lands later and must key off this
// payload, never off hard-coded provider lists — design §4.2).
//
// Query:
//   ?provider=<id>   Optional. Defaults to the local-runtime-v2 host
//                    provider (the only registered host provider until
//                    M4 adds acp/exec). Unknown ids answer 404 — that is
//                    caller confusion, not an engine limitation, and
//                    must never share the 501 reserved for "engine does
//                    not have this capability".
//
// This endpoint is read-only and declaration-backed: it does not boot a
// host and does not probe. Runtime probing (design §2.3 step 2) is a
// later batch; see lib/engine/index.js for why.

import {
  getEngineProvider,
  listEngineProviderIds,
  summarizeUnavailableCapabilities,
} from "../lib/engine/index.js";

function respond(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export function handleEngineCapabilities(req, res) {
  const url = new URL(req.url, "http://localhost");
  const providerId = url.searchParams.get("provider") || undefined;

  let provider;
  try {
    provider = getEngineProvider(providerId);
  } catch (e) {
    // Only caller confusion (unknown provider id) is a 404. Anything else
    // — in particular EngineCapabilityNotSupportedError — must propagate
    // so the HTTP layer's centralised 501 mapping answers it; swallowing
    // it here would turn expected degradation into a wrong status.
    if (!e || e.code !== "unknown_engine_provider") throw e;
    return respond(res, 404, {
      ok: false,
      error: `unknown engine provider "${providerId}"`,
      code: "unknown_engine_provider",
      knownProviders: listEngineProviderIds(),
    });
  }

  return respond(res, 200, {
    ok: true,
    provider: provider.id,
    transport: provider.transport,
    capabilities: provider.capabilities,
    unavailable: summarizeUnavailableCapabilities(provider.capabilities),
  });
}
