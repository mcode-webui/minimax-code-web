// webui/test/routes-alerts.test.js
// Unit tests for server/routes/alerts.js — handleAlerts REST snapshot endpoint.
//
// Why this test exists: lease B02 wires /api/alerts (bell-icon data
// source). With SSE removed (decision 20 — WebSocket event stream +
// REST only) the route collapsed to a plain REST snapshot:
//   GET /api/alerts → 200 application/json
//                   → body {"kind":"snapshot","alerts":[...]} (the ring
//                     buffer from getRecentAlerts()).
// Live append/update traffic rides the /api/stream WebSocket as the
// alerts.append / alerts.update control frames (state-bus'
// attachAlertBridge) — so there is no streaming header, heartbeat, or
// subscriber bookkeeping left to assert on this route.
//
// Test strategy: NO setupMocks — the route's only dependency is the
// pure alerts.js. pushAlert is THE single write point and state-bus
// re-exports the exact same function as its chokepoint alias, so
// injecting via alertsLib.pushAlert below is semantically identical to
// calling state-bus.pushAlert().

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
    pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const alertsRoute = await import(absPath("routes/alerts.js"));
const alertsLib = await import(absPath("lib/alerts.js"));

// Fake res covering both writeHead-style and setHeader-style JSON
// responses: status + headers land in _headers, body accumulates from
// write()/end() chunks.
function fakeRes() {
    const res = {
        _status: null,
        _headers: {},
        _body: "",
        writeHead(s, h) {
            this._status = s;
            if (h) this._headers = h;
        },
        setHeader(k, v) {
            this._headers[k] = v;
        },
        write(chunk) {
            this._body += String(chunk);
            return true;
        },
        end(chunk) {
            if (chunk !== undefined) this._body += String(chunk);
        },
        headerOf(name) {
            for (const [k, v] of Object.entries(this._headers)) {
                if (k.toLowerCase() === String(name).toLowerCase()) return String(v);
            }
            return "";
        },
    };
    return res;
}

describe("handleAlerts — GET /api/alerts (REST)", () => {
    beforeEach(() => {
        alertsLib._resetForTests();
    });

    test("returns 200 application/json with kind=snapshot + alerts array", async () => {
        const res = fakeRes();
        await alertsRoute.handleAlerts({}, res, {});
        assert.equal(res._status, 200);
        assert.ok(
            res.headerOf("Content-Type").includes("application/json"),
            `Content-Type must be application/json, got: ${res.headerOf("Content-Type")}`,
        );
        const body = JSON.parse(res._body);
        assert.equal(body.kind, "snapshot");
        assert.ok(Array.isArray(body.alerts), "body.alerts must be an array");
        // Fresh ring buffer (beforeEach reset) → empty snapshot.
        assert.equal(body.alerts.length, 0);
    });

    test("snapshot carries an injected alert from the pushAlert chokepoint", async () => {
        // state-bus.pushAlert re-exports this exact function — injecting
        // here IS the state-bus.pushAlert path.
        const injected = alertsLib.pushAlert({
            level: "error",
            msg: "boom",
            src: "s",
            cid: "cid-rest",
        });
        const res = fakeRes();
        await alertsRoute.handleAlerts({}, res, {});
        const body = JSON.parse(res._body);
        assert.equal(body.kind, "snapshot");
        const hit = body.alerts.find((a) => a.id === injected.id);
        assert.ok(
            hit,
            `injected alert must appear in the snapshot, got: ${res._body.slice(0, 300)}`,
        );
        assert.equal(hit.msg, "boom");
        assert.equal(hit.level, "error");
        assert.equal(hit.cid, "cid-rest");
    });
});
