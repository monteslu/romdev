// Added to the disk tool's discs package by gen-source.mjs. Upstream writes
// one game's volume identifiers into every image it makes; romdev's build
// copies them from the original disc image instead, so a rebuilt image still
// matches the original without the identifiers being compiled in.
package discs

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"psxdecomp/psx-disk/iso9660"
)

// ReferenceDirs are extracted-disc directories to look beside for the
// original image, after the directory being imaged.
var ReferenceDirs []string

// The original image of an extracted disc <dir>/<ver> is <dir>/*.<ver>.cue,
// the layout the project's own extract step writes.
func romdevReferenceImage(extracted string) *iso9660.Image {
	for _, dir := range append([]string{extracted}, ReferenceDirs...) {
		dir = filepath.Clean(dir)
		cues, _ := filepath.Glob(filepath.Join(filepath.Dir(dir), "*."+filepath.Base(dir)+".cue"))
		sort.Strings(cues)
		for _, cue := range cues {
			if img, err := openImageFromCueFile(cue); err == nil {
				return img
			}
		}
	}
	return nil
}

func romdevSetIdentifiers(img *iso9660.WritableImage, inputPath string) {
	ref := romdevReferenceImage(inputPath)
	if ref == nil {
		fmt.Fprintf(os.Stderr, "warning: no original image (<dir>/*.<ver>.cue) beside %s; volume identifiers left blank\n", inputPath)
		img.Pvd.SystemIdentifier = iso9660.ToAString("PLAYSTATION", 32)
		img.Pvd.VolumeIdentifier = iso9660.ToDString("", 32)
		img.Pvd.PublisherIdentifier = iso9660.ToAString("", 128)
		img.Pvd.DataPreparerIdentifier = iso9660.ToAString("", 128)
		img.Pvd.ApplicationIdentifier = iso9660.ToAString("PLAYSTATION", 128)
		return
	}
	defer ref.Close()
	img.Pvd.SystemIdentifier = ref.Pvd.SystemIdentifier
	img.Pvd.VolumeIdentifier = ref.Pvd.VolumeIdentifier
	img.Pvd.PublisherIdentifier = ref.Pvd.PublisherIdentifier
	img.Pvd.DataPreparerIdentifier = ref.Pvd.DataPreparerIdentifier
	img.Pvd.ApplicationIdentifier = ref.Pvd.ApplicationIdentifier
}
