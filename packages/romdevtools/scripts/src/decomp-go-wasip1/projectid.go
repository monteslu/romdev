// Package projectid is added to the asset tool by gen-source.mjs. The
// upstream tool compiles its project's short name into file paths, env var
// names, its repository slug and its messages; romdev's build reads them from
// the project the tool runs in instead (the working directory), so the name
// is never in the binary: the project's own asset tool lives at
// tools/<name>-assets, and its go.mod module path names the repository.
package projectid

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

var (
	once       sync.Once
	name, repo string
	moduleLine = regexp.MustCompile(`(?m)^module\s+(\S+)`)
)

func load() {
	name = "psx"
	matches, _ := filepath.Glob(filepath.Join("tools", "*-assets", "go.mod"))
	sort.Strings(matches)
	if len(matches) == 0 {
		return
	}
	name = strings.TrimSuffix(filepath.Base(filepath.Dir(matches[0])), "-assets")
	data, err := os.ReadFile(matches[0])
	if err != nil {
		return
	}
	if m := moduleLine.FindSubmatch(data); m != nil {
		// github.com/<owner>/<repo>/tools/<name>-assets
		if p := strings.Split(string(m[1]), "/"); len(p) >= 3 && strings.Contains(p[0], ".") {
			repo = p[1] + "/" + p[2]
		}
	}
}

// Name is the project's short name in lower case ("psx" outside a project).
func Name() string { once.Do(load); return name }

// Upper is Name in upper case, as the project's env vars spell it.
func Upper() string { return strings.ToUpper(Name()) }

// Repo is the project's <owner>/<repo> on GitHub, where its prebuilt
// dependencies are released ("" outside a project).
func Repo() string { once.Do(load); return repo }
