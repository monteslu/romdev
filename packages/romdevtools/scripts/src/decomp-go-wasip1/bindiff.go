// Replaces the asset tool's bindiff.go in romdev's wasip1 build (gen-source.mjs).
// The interactive terminal diff viewer (gobindiff over tcell) has no WASI
// terminal backend; the command reports that instead of linking it.
package main

import "fmt"

func handleBindiff(version, overlay string, bytesPerRow int) error {
	return fmt.Errorf("bindiff (%s %s, %d bytes/row): the interactive terminal viewer is not built for WASI", version, overlay, bytesPerRow)
}
