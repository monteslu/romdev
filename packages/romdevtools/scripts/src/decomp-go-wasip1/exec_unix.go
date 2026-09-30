//go:build !windows

// wasip1 build overlay for tools/sotn-assets/deps/exec_unix.go
// (build-decomp-go-tools.sh): WASI has no sessions and no processes, so a
// detached child cannot exist; exec itself returns ENOSYS.
package deps

import "os/exec"

func cmdSetDetached(cmd *exec.Cmd) {}
