//go:build wasip1

// Added to the asset tool's game package (psxgame) by gen-source.mjs. WASI has no processes: the one child the asset commands start,
// the C preprocessor that reads an enum out of a header, is handed to the
// host instead. romdev's wasi-run.js implements the `romdev` imports by
// running the argv through its own recipe dispatch (cpp -> WASM cc1 -E) and
// returning the exit status and stdout.
package psxgame

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"unsafe"
)

//go:wasmimport romdev exec
func romdevExecImport(req unsafe.Pointer, reqLen uint32) uint32

//go:wasmimport romdev take
func romdevTakeImport(buf unsafe.Pointer)

// romdevLookPath stands in for exec.LookPath: the host resolves the program.
func romdevLookPath(name string) (string, error) { return name, nil }

// romdevOutput stands in for (*exec.Cmd).Output: run cmd.Args on the host,
// in cmd.Dir or else this process's working directory (which the guest may
// have changed since it started).
func romdevOutput(cmd *exec.Cmd) ([]byte, error) {
	dir := cmd.Dir
	if dir == "" {
		wd, err := os.Getwd()
		if err != nil {
			return nil, err
		}
		dir = wd
	}
	req, err := json.Marshal(struct {
		Argv []string `json:"argv"`
		Dir  string   `json:"dir"`
	}{cmd.Args, dir})
	if err != nil {
		return nil, err
	}
	n := romdevExecImport(unsafe.Pointer(&req[0]), uint32(len(req)))
	if n < 4 {
		return nil, fmt.Errorf("romdev exec: short response (%d bytes)", n)
	}
	buf := make([]byte, n)
	romdevTakeImport(unsafe.Pointer(&buf[0]))
	code := int32(binary.LittleEndian.Uint32(buf[:4]))
	out := buf[4:]
	if code != 0 {
		return out, fmt.Errorf("exit status %d", code)
	}
	return out, nil
}
