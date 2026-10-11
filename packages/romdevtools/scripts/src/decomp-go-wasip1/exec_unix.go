//go:build !windows

// Replaces the asset tool's deps/exec_unix.go in romdev's wasip1 build
// (gen-source.mjs): WASI has no sessions and no processes, so a
// detached child cannot exist; exec itself returns ENOSYS.
package deps

import "os/exec"

func cmdSetDetached(cmd *exec.Cmd) {}
