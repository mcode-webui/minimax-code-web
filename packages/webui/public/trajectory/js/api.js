/**
 * The one way this page talks to its own server: a same-origin JSON fetch that
 * carries the panel's capability, read from the URL fragment.
 *
 * A missing capability is reported as its own error rather than as a generic HTTP
 * failure, because the fix is a specific one — open the URL the agent returned,
 * including its `#t=…` fragment, instead of a hand-edited or truncated copy.
 */

import { panelToken } from './state.js';

/**
 * v2.1 (in-product): the panel can be served standalone (page at `/`) or
 * mounted inside the webui (page at `/trajectory/`). Derive the API base
 * from the page URL so both work from one build: strip a trailing
 * `/` or `/index.html` and prefix every call with what remains.
 */
const API_BASE = (() => {
  const stripped = location.pathname.replace(/\/(index\.html)?$/, '');
  return stripped || '';
})();

export class UnauthorizedPanelError extends Error {
  constructor() {
    super('unauthorized_panel_url');
    this.name = 'UnauthorizedPanelError';
  }
}

export async function api(pathname) {
  const token = panelToken();
  const response = await fetch(API_BASE + pathname, {
    headers: token ? { 'x-trajectory-token': token } : {},
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 403 && payload.error === 'forbidden_token') throw new UnauthorizedPanelError();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}
