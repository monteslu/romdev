// Progressive disclosure: ship a tiny entry-tier of tools at session init;
// register the rest on demand via loadCategory.
//
// Why: Anthropic's own benchmarks (MCP design research, 2026-05-23 session)
// show lazy tool loading moves Opus 4 from 49% → 74% on tool-selection
// accuracy. The benefit is larger for weaker models: a 5-tool surface is
// navigable; a 65-tool surface induces decision paralysis even before the
// agent picks the wrong one.
//
// Design constraint: "narrow at entry, deep once in."
// Recipes don't gate primitives; categories don't hide capabilities. Any
// agent can load any category at any time. The "all" pseudo-category
// loads everything in one call for power users who don't want the dance.
//
// Mitigations for weaker-model failure modes:
// 1. loadCategory's response includes the FULL SCHEMAS of every tool it
//    just registered, so the agent can call them immediately without
//    waiting for tools/list_changed to propagate (which is async).
// 2. listCategories and per-tool descriptions include a `next_steps`
//    hint pointing weaker agents at the right load call.
// 3. Tool-not-found errors include the category to load when the tool
//    exists but hasn't been loaded yet.
//
// Capable agents skip all this by calling loadCategory({category:"all"})
// as their first call; they then have the full surface unchanged.

/**
 * @typedef {Object} Category
 * @property {string} name
 * @property {string} description user-facing one-liner
 * @property {string[]} useWhen 1-3 hints about when this category matters
 * @property {(server: any, z: any) => void} register the original register fn
 */

/**
 * Build a per-session disclosure manager. One per McpServer instance.
 * @param {any} server the McpServer
 * @param {any} z zod
 * @param {Category[]} categories all loadable categories
 * @param {string} sessionKey per-MCP-session host scope key — forwarded
 *   to each category's register fn so tool handlers can call
 *   getHost(sessionKey) and friends.
 */
export function createDisclosure(server, z, categories, sessionKey) {
  const byName = new Map(categories.map((c) => [c.name, c]));
  const loaded = new Set();
  // Session-scoped one-shot flags used by tool handlers to nudge agents
  // without spamming every response. Each flag fires at most once per
  // session, gated by whether the relevant tip is still useful.
  const shownHints = new Set();

  /** @returns {string[]} names of every tool currently registered. */
  function listRegistered() {
    return Object.keys(server._registeredTools ?? {});
  }

  /**
   * Crawl a Zod schema node and return {type, optional, description, enum?}.
   * Handles ZodMiniObject (def.shape), optionals, defaults, enums, and the
   * basic primitives (string/number/boolean/array/object). Returns "unknown"
   * for shapes we don't recognize — better than crashing the discovery flow.
   */
  function summarizeZod(node) {
    if (!node) return { type: "unknown" };
    const def = node.def ?? node._def;
    if (!def) return { type: "unknown" };
    let type = def.type ?? "unknown";
    let optional = false;
    let description = node.description ?? def.description ?? undefined;
    let enumValues;
    // Unwrap optional / default wrappers (zod-mini wraps the inner type in def.innerType).
    if ((type === "optional" || type === "default") && def.innerType) {
      const inner = summarizeZod(def.innerType);
      optional = true;
      type = inner.type;
      description = description ?? inner.description;
      enumValues = inner.enum;
    }
    if (type === "enum" && def.entries) {
      // zod-mini: def.entries is { value: value } object; values are the enum members.
      enumValues = Array.isArray(def.entries)
        ? def.entries.map((e) => e.value ?? e)
        : Object.values(def.entries);
    } else if (type === "enum" && def.values) {
      enumValues = Object.values(def.values);
    }
    const out = { type };
    if (optional) out.optional = true;
    if (description) out.description = description;
    if (enumValues) out.enum = enumValues;
    return out;
  }

  /** Snapshot of one tool's exposed schema for the response. */
  function describe(name) {
    const t = server._registeredTools?.[name];
    if (!t) return null;
    // ZodMiniObject stores field shape at inputSchema.shape (zod-mini) or
    // inputSchema._def.shape() (classic zod). Try both. Fall back to an
    // empty params list rather than the schema's method names.
    let shape = null;
    if (t.inputSchema?.shape && typeof t.inputSchema.shape === "object") {
      shape = t.inputSchema.shape;
    } else if (typeof t.inputSchema?._def?.shape === "function") {
      shape = t.inputSchema._def.shape();
    } else if (t.inputSchema?._def?.shape && typeof t.inputSchema._def.shape === "object") {
      shape = t.inputSchema._def.shape;
    }
    const parameters = shape
      ? Object.entries(shape).map(([key, schema]) => ({ name: key, ...summarizeZod(schema) }))
      : [];
    return {
      name,
      description: t.description ?? "",
      parameters,
    };
  }

  /**
   * Load a category. Idempotent — calling twice is fine. Returns the
   * tool schemas the agent can now use immediately (no wait for
   * tools/list_changed).
   * @param {string} name
   */
  // Each category's register() function may include tools whose names
  // collide with already-registered ones (entry-tier `getStatus`, etc.).
  // MCP SDK throws "Tool X is already registered" on collision and
  // aborts further registration in that category. Wrap server.tool/
  // registerTool with skip-existing semantics so categories register
  // partially-and-cleanly instead of partially-and-broken.
  function registerCategorySafely(cat) {
    const orig = server.tool.bind(server);
    const origRegister = server.registerTool?.bind(server);
    let skippedDupes = 0;
    server.tool = (name, ...rest) => {
      if (server._registeredTools?.[name]) {
        skippedDupes++;
        return null; // silently skip; caller doesn't need the handle
      }
      return orig(name, ...rest);
    };
    if (origRegister) {
      server.registerTool = (name, ...rest) => {
        if (server._registeredTools?.[name]) {
          skippedDupes++;
          return null;
        }
        return origRegister(name, ...rest);
      };
    }
    try {
      cat.register(server, z, sessionKey);
    } finally {
      server.tool = orig;
      if (origRegister) server.registerTool = origRegister;
    }
    return skippedDupes;
  }

  /** Like describe() but only returns {name, description} — keeps the
   * loadCategory response small. Agents pull full schemas via
   * describeTool on demand. */
  function describeBrief(name) {
    const t = server._registeredTools?.[name];
    if (!t) return null;
    return {
      name,
      // Truncate description to ~200 chars — enough to know what the tool
      // is for, not enough to blow the response cap when 60+ tools load.
      description: (t.description ?? "").slice(0, 200),
    };
  }

  function loadCategory(name, opts = {}) {
    const verbose = !!opts.verbose;
    const describeFn = verbose ? describe : describeBrief;
    if (name === "all") {
      const loadedNames = [];
      let totalSkipped = 0;
      for (const cat of categories) {
        if (!loaded.has(cat.name)) {
          totalSkipped += registerCategorySafely(cat);
          loaded.add(cat.name);
          loadedNames.push(cat.name);
        }
      }
      return {
        loaded: loadedNames,
        alreadyLoaded: [...loaded].filter((c) => !loadedNames.includes(c)),
        tools: listRegistered().map(describeFn).filter(Boolean),
        skippedDuplicates: totalSkipped,
      };
    }

    const cat = byName.get(name);
    if (!cat) {
      throw new Error(
        `unknown category '${name}'. Available: ${[...byName.keys()].join(", ")}, or 'all'. ` +
        `Call listCategories() for descriptions.`
      );
    }
    if (loaded.has(name)) {
      return {
        loaded: [],
        alreadyLoaded: [name],
        tools: listRegistered().map(describeFn).filter(Boolean),
      };
    }
    // Snapshot what's registered BEFORE this category loads, so we can
    // return ONLY the newly-added tool schemas (not the entry-tier ones
    // the agent already has).
    const before = new Set(listRegistered());
    const skipped = registerCategorySafely(cat);
    loaded.add(name);
    const added = listRegistered().filter((n) => !before.has(n));
    return {
      loaded: [name],
      alreadyLoaded: [],
      tools: added.map(describeFn).filter(Boolean),
      skippedDuplicates: skipped,
    };
  }

  /** @returns {{name, description, useWhen, loaded}[]} */
  function listCategories() {
    return categories.map((c) => ({
      name: c.name,
      description: c.description,
      useWhen: c.useWhen,
      loaded: loaded.has(c.name),
    }));
  }

  function isLoaded(catName) {
    return loaded.has(catName);
  }

  /**
   * One-shot session hint. Returns the message the first time it's called
   * with a given key, then null thereafter. Lets handlers emit a nudge
   * without spamming every response.
   */
  function consumeHint(key, message) {
    if (shownHints.has(key)) return null;
    shownHints.add(key);
    return message;
  }

  return { loadCategory, listCategories, describe, isLoaded, consumeHint };
}
