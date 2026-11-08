// Copied from wasmcart's src/cartVersion.js (wasmcart 0.39.0, which exports it
// as resolveCartVersion); once romdev's wasmcart pin includes it, import it from
// there instead. Keep the two the same: a cart packed by romdev and one packed by
// wasmcart-pack must say the same version.
//
// The version a cart carries in its manifest. One rule, the same one
// cartwheel's cw_add_app and cwexport follow, so a cart says what it is
// wherever it was built:
//
//   resolveCartVersion({ set, dirs, fallback })
//     set       an explicit version (the pack tool's `version`): always wins
//     dirs      directories to read a git version from, first checkout wins
//     fallback  a version the source already carries (a --source manifest's)
//   the first of them that gives one, else 0.1.0.
//
// A git checkout's version: at a v<semver> tag with no changes to tracked
// files, the tag without its v (a tag build is the release by construction);
// otherwise the highest v<semver> tag reachable from HEAD plus -dev.g<commit>
// (0.0.0-dev.g<commit> before the first tag), so a dev build is never taken
// for a release.
//
// Every version is semver 2.0.0: launchers, stores and npm compare versions
// as semver, so a version that is not one is refused rather than packed.
// Node only (it runs git); hosts never call it.
import { spawnSync } from 'node:child_process';

/** The version a cart gets when nothing says otherwise. */
export const DEFAULT_CART_VERSION = '0.1.0';

/**
 * What is wrong with a version as semver 2.0.0 (MAJOR.MINOR.PATCH, optionally
 * -prerelease and +build), or null when it is fine.
 * @param {string} v
 * @returns {string|null}
 */
export function semverProblem(v) {
  const id = '[0-9A-Za-z-]+';
  const m = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${id}(?:\\.${id})*))?(?:\\+${id}(?:\\.${id})*)?$`).exec(String(v));
  if (!m) return 'not MAJOR.MINOR.PATCH[-prerelease][+build], or a number with a leading zero';
  const bad = (m[4] || '').split('.').find((x) => /^0\d+$/.test(x));
  return bad ? `prerelease identifier ${bad} is a number with a leading zero` : null;
}

/**
 * The version of the git checkout holding `dir` (see the top of this file),
 * or null when `dir` is not inside one or git is not installed.
 * The g before the commit keeps the identifier valid semver when the
 * abbreviated commit is all digits with a leading zero.
 * @param {string} dir
 * @returns {string|null}
 */
export function gitVersion(dir) {
  const git = (...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const sha = git('rev-parse', '--short=7', 'HEAD');
  if (!sha) return null;
  const semverTag = (t) => (t && t.startsWith('v') && !semverProblem(t.slice(1)) ? t.slice(1) : null);
  const exact = (git('tag', '--points-at', 'HEAD', '--list', 'v[0-9]*') || '').split('\n').map(semverTag).filter(Boolean);
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  if (exact.length && dirty === '') return exact.sort(compareSemver).at(-1);
  // the highest v<semver> tag reachable from HEAD. Not `git describe`: it
  // returns the nearest tag matching a glob, and a nearer v-tag that is not
  // semver (v1.4) would hide the real one.
  const last = (git('tag', '--merged', 'HEAD', '--list', 'v[0-9]*') || '').split('\n').map(semverTag).filter(Boolean).sort(compareSemver).at(-1);
  return `${last || '0.0.0'}-dev.g${sha}`;
}

/** semver precedence of two release versions (prereleases sort before their release) */
function compareSemver(a, b) {
  const p = (v) => v.split(/[-+]/)[0].split('.').map(Number);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return (a.includes('-') ? 0 : 1) - (b.includes('-') ? 0 : 1);
}

/**
 * @param {{set?: string|null, dirs?: (string|null|undefined)[], fallback?: string|null}} o
 * @returns {{version: string, from: string, error: string|null}}
 *   from: 'set', 'git <dir>', 'fallback' or 'default'
 */
export function resolveCartVersion({ set, dirs = [], fallback } = {}) {
  let version = null, from = null;
  if (set !== undefined && set !== null) [version, from] = [String(set), 'set'];
  else {
    for (const dir of dirs) {
      if (dir && (version = gitVersion(dir))) { from = `git ${dir}`; break; }
    }
    if (!version && fallback !== undefined && fallback !== null) [version, from] = [String(fallback), 'fallback'];
    if (!version) [version, from] = [DEFAULT_CART_VERSION, 'default'];
  }
  const why = semverProblem(version);
  return {
    version, from,
    error: why ? `version "${version}" (${from}) is not semver (${why}): use 1.2.3, 1.2.3-rc.1 or 1.2.3-dev.g1a2b3c4` : null,
  };
}
