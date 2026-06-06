// Swagger UI page for GET /documentation — served entirely from the bundled
// `swagger-ui-dist` package. NO CDN: the CSS + JS are served from our own
// /documentation/* routes off the local node_modules, so the docs work fully
// offline / airgapped (consistent with romdev's no-network ethos).

import { getAbsoluteFSPath } from "swagger-ui-dist";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = getAbsoluteFSPath(); // absolute path to swagger-ui-dist assets

/** Read a bundled swagger-ui asset by filename (cached). */
const _cache = new Map();
export function swaggerAsset(name) {
  // allow only the known asset filenames (no path traversal)
  if (!/^swagger-ui(-bundle|-standalone-preset)?\.(js|css)$/.test(name) &&
      name !== "swagger-ui.css" && name !== "swagger-ui-bundle.js") {
    return null;
  }
  if (_cache.has(name)) return _cache.get(name);
  try {
    const buf = readFileSync(join(DIST, name));
    _cache.set(name, buf);
    return buf;
  } catch {
    return null;
  }
}

/**
 * The /documentation HTML — references LOCAL assets (served by the route layer
 * from swagger-ui-dist), never a CDN.
 * @param {{specUrl?: string, title?: string, assetBase?: string}} [opts]
 * @returns {string} HTML
 */
export function swaggerHtml(opts = {}) {
  const specUrl = opts.specUrl ?? "/openapi.json";
  const title = opts.title ?? "romdev API";
  const base = opts.assetBase ?? "/documentation";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${base}/swagger-ui.css" />
  <style>
    body { margin: 0; background: #fafafa; }
    #fallback { font-family: system-ui, sans-serif; padding: 2rem; max-width: 40rem; margin: 0 auto; }
    #fallback code { background: #eee; padding: 0.1em 0.3em; border-radius: 3px; }
  </style>
</head>
<body>
  <div id="fallback">
    <h1>${escapeHtml(title)}</h1>
    <p>Loading interactive docs… If this doesn't render, the raw OpenAPI spec is at
       <a href="${specUrl}"><code>${specUrl}</code></a>, every tool is callable via
       <code>POST /tool/{name}</code>, and the workflow guide is at
       <a href="/romdev-skill.md"><code>/romdev-skill.md</code></a>.</p>
  </div>
  <div id="swagger-ui"></div>
  <script src="${base}/swagger-ui-bundle.js"></script>
  <script>
    window.onload = function () {
      if (typeof SwaggerUIBundle === "undefined") return; // assets missing → keep fallback
      document.getElementById('fallback').style.display = 'none';
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: '#swagger-ui',
        deepLinking: true,
        tryItOutEnabled: true,
        presets: [SwaggerUIBundle.presets.apis],
      });
    };
  </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
