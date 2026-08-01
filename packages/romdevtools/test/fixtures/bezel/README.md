# Integration fixture: a minimal Active Bezel

`main.wasm` is a 679-byte guest that clears the canvas and draws the game.
It exists so the Active Bezel integration tests have a package to load.

**This is deliberately OURS, not borrowed from the dependency.** These tests
used to resolve `active-bezel/examples/diagnostic` through `require.resolve`.
When that directory was removed upstream in 0.4.1 the path went missing, the
suite's `skip: !HAVE_BEZEL` guard fired, and ten integration tests silently
stopped running for a whole release. A fixture a test depends on belongs in
the test tree, where nothing outside this repository can move it.

Rebuild (only needed if the ABI changes):

    cd active-bezels/runtimes/c/start && ./build.sh
