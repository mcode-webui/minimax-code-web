// webui/server/routes/alerts.js
// GET /api/alerts — REST snapshot of the alert ring buffer.
//
// Real-time append/update traffic is delivered over the WebSocket event
// stream (/api/stream) as the `alerts.append` / `alerts.update` control
// frames (see state-bus.js#attachAlertBridge). The frontend fetches this
// snapshot once after each stream connection is established and dedupes
// the live frames against it by alert.id.

import { getRecentAlerts } from "../lib/alerts.js";

export async function handleAlerts(req, res, _ctx) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ kind: "snapshot", alerts: getRecentAlerts() }));
    return true;
}
