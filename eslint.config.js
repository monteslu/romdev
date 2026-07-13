// ESLint flat config for the romdev monorepo.
//
// Deliberately lean: plain JavaScript ESM (no TypeScript), so we run the
// recommended JS rules plus a few that actually catch BUGS in this codebase —
// undefined variable references and unused vars/imports (the class of typo a
// build-time syntax check + node --test does NOT catch). Style is left alone.
//
// Run: `npm run lint` (or `npm run lint:fix`).

import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // Don't lint third-party / generated trees: vendored SDK source (SGDK,
    // PVSnesLib, libtonc, C-BIOS, etc.), compiled wasm, build output, deps.
    ignores: [
      "**/node_modules/**",
      "**/wasm/**",
      // Generated Emscripten module glue that doesn't live under a wasm/ dir.
      "packages/romdev-audio-resampler/resampler.mjs",
      "**/build/**",
      "**/.romdev-build/**",
      "**/.claude/**",     // workflow scripts — top-level return, not project ESM
      "**/dist/**",
      // Vendored upstream SDK / lib C sources we ship but don't author.
      "packages/*/src/platforms/*/lib/**",
      // Bundled game/example C & asm — not our JS.
      "**/*.c",
      "**/*.h",
      "**/*.s",
      "**/*.asm",
    ],
  },

  js.configs.recommended,

  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // The bug-catchers we actually want — these are why we added a linter:
      // undefined references, unused vars/imports, real defects (dupe keys,
      // self-assignment, always-true comparisons). Kept at "error".
      "no-undef": "error",
      "no-unused-vars": [
        "error",
        {
          // Allow intentionally-unused: _-prefixed args/vars and caught errors.
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      // Genuine-defect rules from recommended — keep on.
      // (no-dupe-keys, no-self-assign, no-constant-binary-expression,
      //  no-dupe-args, no-unreachable, etc. all stay at their recommended level.)
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],

      // OFF — opinionated/stylistic rules that fire heavily on deliberate
      // existing code and aren't bugs in this codebase. Re-enable case-by-case
      // later if desired; for now they'd only bury the real findings.
      "no-useless-assignment": "off",   // intentional throwaway assigns in parsers/decoders
      "preserve-caught-error": "off",   // our thrown errors are deliberately reworded, not chained
      "no-useless-escape": "off",       // regex-in-template escaping is intentional/harmless
      "no-control-regex": "off",        // control chars in sanitizers are on purpose
      "no-irregular-whitespace": "off",
      "no-regex-spaces": "off",
    },
  },

  {
    // Test files: same rules, plus the node:test globals if any are used bare.
    files: ["**/*.test.js", "**/test/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
