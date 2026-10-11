// Added to the asset tool's package main by gen-source.mjs. Upstream compiles in tables named after the
// game's stages, bosses and characters for its objdiff/progress and Saturn
// commands. romdev's build drops them: an overlay's kind comes from its code,
// its label is the code itself, and the Saturn overlay lists are read from
// the project's own config/saturn/ when needed, so no game text ships.
package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var (
	romdevWeaponID = regexp.MustCompile(`^w[01]_\d+$`)
	romdevBossID   = regexp.MustCompile(`^r?bo\d+$`)
)

func romdevMetaOverlayOf(id, kind string) metaOverlay {
	if kind == "weapon" {
		return metaOverlay{id, kind, id}
	}
	return metaOverlay{id, kind, strings.ToUpper(id)}
}

// romdevMetaOverlay maps a splat basename to its overlay: st<code> is a stage
// (the title screen, stsel, counts as engine), bo<code> a boss, tt_NNN a
// servant, w0_NNN/w1_NNN a weapon, anything else engine code.
func romdevMetaOverlay(basename string) (metaOverlay, bool) {
	switch {
	case basename == "":
		return metaOverlay{}, false
	case basename == "stsel":
		return romdevMetaOverlayOf("sel", "engine"), true
	case strings.HasPrefix(basename, "tt_"):
		return romdevMetaOverlayOf(basename, "servant"), true
	case romdevWeaponID.MatchString(basename):
		return romdevMetaOverlayOf(basename, "weapon"), true
	case strings.HasPrefix(basename, "st") && len(basename) > 2:
		return romdevMetaOverlayOf(basename[2:], "st"), true
	case strings.HasPrefix(basename, "bo") && len(basename) > 2:
		return romdevMetaOverlayOf(basename[2:], "bo"), true
	}
	return romdevMetaOverlayOf(basename, "engine"), true
}

// romdevMetaOverlayByID maps an overlay code taken from a target file name
// (ARE.BIN -> are) to its overlay. Boss codes are bo<N>, rbo<N> and mar;
// engine code is the title screen, the overlays without a stage directory
// (fname, sd, tek) and whatever has its own directory under src/ (main, dra,
// the playable characters, weapon); every other code is a stage.
func romdevMetaOverlayByID(id string) metaOverlay {
	switch {
	case strings.HasPrefix(id, "tt_"):
		return romdevMetaOverlayOf(id, "servant")
	case romdevWeaponID.MatchString(id):
		return romdevMetaOverlayOf(id, "weapon")
	case romdevBossID.MatchString(id) || id == "mar":
		return romdevMetaOverlayOf(id, "bo")
	case id == "sel" || id == "fname" || id == "sd" || id == "tek" || id == "main" || id == "dra" || id == "weapon":
		return romdevMetaOverlayOf(id, "engine")
	}
	if fi, err := os.Stat(filepath.Join("src", id)); err == nil && fi.IsDir() {
		return romdevMetaOverlayOf(id, "engine")
	}
	return romdevMetaOverlayOf(id, "st")
}

const romdevSaturnConfigDir = "config/saturn"

// Splitter configs, base names without the .bin.yaml / .prg.yaml suffix.
// zero must be split first, then game; the rest in name order.
func romdevSaturnOverlayIDs() []string {
	ids := []string{"zero", "game"}
	matches, _ := filepath.Glob(filepath.Join(romdevSaturnConfigDir, "*.prg.yaml"))
	sort.Strings(matches)
	for _, m := range matches {
		id := strings.TrimSuffix(filepath.Base(m), ".prg.yaml")
		if id != "zero" && id != "game" {
			ids = append(ids, id)
		}
	}
	return ids
}

func romdevSaturnYAML(id string) string {
	if id == "zero" {
		return filepath.Join(romdevSaturnConfigDir, "zero.bin.yaml")
	}
	return filepath.Join(romdevSaturnConfigDir, id+".prg.yaml")
}

func romdevSaturnSplitterYAMLs() []string {
	var out []string
	for _, id := range romdevSaturnOverlayIDs() {
		out = append(out, romdevSaturnYAML(id))
	}
	return out
}

// What the splitter leaves behind: one linker script per config plus the
// symbol files and asm of the shared overlays.
func romdevSaturnExtractSentinels() []string {
	out := []string{
		"asm/saturn/game",
		filepath.Join(romdevSaturnConfigDir, "game_syms.txt"),
		filepath.Join(romdevSaturnConfigDir, "zero_syms.txt"),
	}
	for _, id := range romdevSaturnOverlayIDs() {
		out = append(out, filepath.Join(romdevSaturnConfigDir, id+".ld"))
	}
	return out
}

// Overlays measured in the Saturn progress report: every splitter config but
// the stage_15/stage_16 pair and their reversed versions, which upstream
// leaves out. Labelled by id.
var romdevSaturnUnmeasured = map[string]bool{"stage_15": true, "rstage15": true, "stage_16": true, "rstage16": true}

func romdevSaturnOverlays() []saturnOverlay {
	var out []saturnOverlay
	for _, id := range romdevSaturnOverlayIDs() {
		if romdevSaturnUnmeasured[id] {
			continue
		}
		out = append(out, saturnOverlay{id, strings.ToUpper(id), romdevSaturnYAML(id)})
	}
	return out
}
