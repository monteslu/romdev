// Swagger UI page for GET /documentation — a self-contained HTML doc that renders
// the OpenAPI spec at /openapi.json with a live "try it out" console for the
// /tool/:name routes.
//
// Delivery choice: a tiny HTML page that loads Swagger UI from the jsDelivr CDN.
// Zero new npm dependency (keeps the install lean). The page degrades to a plain
// link to /openapi.json if the CDN is unreachable (airgapped boxes) — so the spec
// is always usable even when the rich UI isn't. (If we later want fully-offline
// UI, add `swagger-ui-dist` and serve its assets; the route stays the same.)

/**
 * @param {{specUrl?: string, title?: string}} [opts]
 * @returns {string} HTML
 */
export function swaggerHtml(opts = {}) {
  const specUrl = opts.specUrl ?? "/openapi.json";
  const title = opts.title ?? "romdev API";
  // Pinned Swagger UI version for reproducibility.
  const SWAGGER = "5.17.14";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER}/swagger-ui.css" />
  <style>
    body { margin: 0; background: #fafafa; }
    #fallback { font-family: system-ui, sans-serif; padding: 2rem; max-width: 40rem; margin: 0 auto; }
    #fallback code { background: #eee; padding: 0.1em 0.3em; border-radius: 3px; }
  </style>
</head>
<body>
  <div id="fallback">
    <h1>${escapeHtml(title)}</h1>
    <p>Loading interactive docs… If this doesn't render (e.g. no network), the raw
       OpenAPI spec is at <a href="${specUrl}"><code>${specUrl}</code></a> and every
       tool is callable via <code>POST /tool/{name}</code>. The workflow guide is at
       <a href="/romdev-skill.md"><code>/romdev-skill.md</code></a>.</p>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER}/swagger-ui-bundle.js" crossorigin
          onload="initSwagger()" onerror="document.getElementById('swagger-ui').innerHTML=''"></script>
  <script>
    function initSwagger() {
      document.getElementById('fallback').style.display = 'none';
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: '#swagger-ui',
        deepLinking: true,
        tryItOutEnabled: true,
        presets: [SwaggerUIBundle.presets.apis],
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
