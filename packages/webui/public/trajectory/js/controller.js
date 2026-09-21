/**
 * The composition root for intents.
 *
 * The one place that knows what an announced user action should actually do.
 * Subscribing here — instead of letting each surface import the action — is what
 * keeps the module graph acyclic: surfaces depend only on the intent leaf, while
 * the actions they would otherwise import depend on the surfaces to render. The
 * dependency now runs one way, from this controller down.
 */

import { on } from './bus.js';
import { SELECT_SESSION, LOCATE_ROW, LOCATE_TOOL_CALL, OPEN_INSPECTOR } from './intents.js';
import { selectSession, locateRow, locateToolCall } from './flow.js';
import { openInspector } from './inspector.js';

/** Bind every intent to its action. Call once, before any surface can emit. */
export function installController() {
  on(SELECT_SESSION, ({ sessionId }) => selectSession(sessionId));
  on(LOCATE_ROW, ({ rowId }) => locateRow(rowId));
  on(LOCATE_TOOL_CALL, ({ toolCallId }) => locateToolCall(toolCallId));
  on(OPEN_INSPECTOR, (selection) => openInspector(selection));
}
