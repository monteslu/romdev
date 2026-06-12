#!/usr/bin/env bash
# Build the Ghidra decompiler (pseudocode / `disasm({target:'decompile'})`) to
# WASM + compile SLEIGH processor specs for all 14 retro CPUs.
#
# Two artifact kinds, both shipped via romdev-analysis-decompiler:
#   - decompile.{js,wasm}  — Ghidra's standalone decompiler REPL (raw_arch +
#     SLEIGH, NO libbfd, NO rizin), driven one-shot via stdin commands.
#   - sleigh/*.sla + .ldefs/.pspec/.cspec — compiled processor tables.
#
# Source provenance (fetch-on-demand, never vendored; only the built .wasm/.sla
# ship). All pinned in versions.json under `analysis`:
#   - Ghidra decompiler C++ + stock 6502/65c02/z80/ARM/68000 specs: via rz-ghidra
#     (its `ghidra/ghidra` submodule). Apache-2.0 (Ghidra) / LGPL-3.0 (rz-ghidra
#     build glue — only Ghidra's own C++ is linked into the shipped binary).
#   - SM83 (GB): Gekkio/GhidraBoy, Apache-2.0.
#   - 65816 (SNES): joshleaves/ghidra-snes, MIT.
#   - HuC6280 (PCE): TiCoKH/Ghidra_HuC6280 — Apache-2.0 by derivation from
#     Ghidra's own 6502 spec (see NOTICE + versions.json licenseNote).
#
# Native `sleighc` is a build-time codegen tool (compiles .slaspec→.sla on the
# HOST); it is NOT shipped. The decompiler WASM is ~2.5MB; the .sla specs ~12MB.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd g++
require_cmd make

DEC_SRC="$BUILD_DIR/rz-ghidra"
CPP="$DEC_SRC/ghidra/ghidra/Ghidra/Features/Decompiler/src/decompile/cpp"
PROC="$DEC_SRC/ghidra/ghidra/Ghidra/Processors"
GHIDRABOY="$BUILD_DIR/GhidraBoy"
SNES="$BUILD_DIR/ghidra-snes"
HUC="$BUILD_DIR/Ghidra_HuC6280"
STAGE="$PROJECT_DIR/src/analysis/decompiler"
PKG="$PROJECT_DIR/../romdev-analysis-decompiler"
SLA_OUT="$BUILD_DIR/sla-out"

# ── fetch sources (rz-ghidra needs its ghidra submodule) ────────────────────
fetch_pinned "analysis.rz-ghidra" "$DEC_SRC"
if [ ! -f "$CPP/sleigh.cc" ]; then
  echo "==> init rz-ghidra ghidra submodule"
  git -C "$DEC_SRC" submodule update --init --depth 1 ghidra/ghidra
fi
fetch_pinned "analysis.sleigh_specs.ghidraboy" "$GHIDRABOY"
fetch_pinned "analysis.sleigh_specs.ghidra_snes" "$SNES"
fetch_pinned "analysis.sleigh_specs.ghidra_huc6280" "$HUC"

# ── 1. native sleighc (host codegen tool; not shipped) ──────────────────────
if [ ! -x "$CPP/sleigh_opt" ]; then
  echo "==> building native sleighc"
  ( cd "$CPP" && make sleigh_opt -j"$(nproc)" )
fi
SLEIGHC="$CPP/sleigh_opt"

# ── 2. compile .sla for all 8 language tables ───────────────────────────────
echo "==> compiling SLEIGH specs → .sla"
mkdir -p "$SLA_OUT"
compile_sla() { # <slaspec> <out-name>
  local spec="$1" name="$2"
  [ -f "$SLA_OUT/$name.sla" ] && [ "$SLA_OUT/$name.sla" -nt "$spec" ] && return 0
  "$SLEIGHC" "$spec" "$SLA_OUT/$name.sla" >/dev/null 2>&1 || {
    echo "FATAL: sleighc failed on $spec" >&2; exit 1; }
}
# stock (from Ghidra via rz-ghidra submodule)
compile_sla "$PROC/6502/data/languages/6502.slaspec"   6502
compile_sla "$PROC/6502/data/languages/65c02.slaspec"  65c02
compile_sla "$PROC/Z80/data/languages/z80.slaspec"     z80
compile_sla "$PROC/ARM/data/languages/ARM4t_le.slaspec" ARM4t_le
compile_sla "$PROC/68000/data/languages/68040.slaspec" 68040
# external (community specs)
compile_sla "$GHIDRABOY/data/languages/sm83.slaspec"   sm83
compile_sla "$SNES/data/languages/65816.slaspec"       65816
compile_sla "$HUC/Ghidra/Processors/HuC6280/data/languages/HuC6280.slaspec" HuC6280

# ── 3. assemble the SLEIGH home (flat: .sla + .ldefs/.pspec/.cspec) ─────────
echo "==> assembling SLEIGH home"
SLEIGH_HOME="$BUILD_DIR/sleighhome/specs"
rm -rf "$SLEIGH_HOME"; mkdir -p "$SLEIGH_HOME"
cp "$SLA_OUT"/*.sla "$SLEIGH_HOME/"
# stock spec metadata
cp "$PROC/6502/data/languages/"6502.{ldefs,pspec,cspec} "$SLEIGH_HOME/"
cp "$PROC/Z80/data/languages/"z80.{ldefs,pspec,cspec} "$SLEIGH_HOME/"
cp "$PROC/ARM/data/languages/"ARM.ldefs "$PROC/ARM/data/languages/"ARMt_v45.pspec \
   "$PROC/ARM/data/languages/"ARM_v45.{pspec,cspec} "$SLEIGH_HOME/"
cp "$PROC/68000/data/languages/"68000.{ldefs,pspec,cspec} "$PROC/68000/data/languages/"68000_register.cspec "$SLEIGH_HOME/"
# external spec metadata
cp "$GHIDRABOY/data/languages/"sm83.{ldefs,pspec,cspec} "$SLEIGH_HOME/"
cp "$SNES/data/languages/"65816.{ldefs,cspec} "$SNES/data/languages/"65816-snes.pspec "$SLEIGH_HOME/"
cp "$HUC/Ghidra/Processors/HuC6280/data/languages/"HuC6280.{ldefs,pspec,cspec} "$SLEIGH_HOME/"

# ── 4. WASM decompiler ──────────────────────────────────────────────────────
echo "==> building WASM decompiler"
OBJ="$BUILD_DIR/decomp-obj"; mkdir -p "$OBJ"
CXXF="-O2 -std=c++11 -fexceptions -I$CPP"
# Source sets (Makefile groups), MINUS bfd loaders (codedata/bfd_arch/
# loadimage_bfd need libbfd) and the sleigh-compiler/ghidra-XML-peer/test bits.
CORE="xml marshal space float address pcoderaw translate opcodes globalcontext"
DECCORE="capability architecture options graph cover block cast typeop database cpool comment stringmanage fspec action loadimage grammar varnode op type variable varmap jumptable emulate emulateutil flow userop funcdata funcdata_block funcdata_op funcdata_varnode unionresolve pcodeinject heritage prefersplit rangeutil ruleaction subflow blockaction merge double transform coreaction condexe override dynamic crc32 prettyprint printlanguage printc printjava memstate opbehavior paramid"
SLEIGH="sleigh pcodeparse pcodecompile sleighbase slghsymbol slghpatexpress slghpattern semantics context filemanage"
EXTRA="callgraph ifacedecomp ifaceterm inject_sleigh interface libdecomp loadimage_xml raw_arch sleigh_arch testfunction xml_arch"
REPL="consolemain"
for s in $CORE $DECCORE $SLEIGH $EXTRA $REPL; do
  [ -f "$CPP/$s.cc" ] || { echo "FATAL: missing $CPP/$s.cc" >&2; exit 1; }
  [ -f "$OBJ/$s.o" ] && [ "$OBJ/$s.o" -nt "$CPP/$s.cc" ] && continue
  emcc $CXXF -c "$CPP/$s.cc" -o "$OBJ/$s.o"
done
emcc -O2 -fexceptions \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 -sSTACK_SIZE=8388608 \
  -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,ENV \
  -sEXPORTED_FUNCTIONS=_main,_malloc,_free \
  -o "$BUILD_DIR/decompile.js" "$OBJ"/*.o

# ── 5. stage → src staging (gitignored) + the shipped package ───────────────
echo "==> staging"
for d in "$STAGE/wasm" "$STAGE/sleigh" "$PKG/wasm" "$PKG/sleigh"; do mkdir -p "$d"; done
cp "$BUILD_DIR/decompile.js" "$BUILD_DIR/decompile.wasm" "$STAGE/wasm/"
cp "$BUILD_DIR/decompile.js" "$BUILD_DIR/decompile.wasm" "$PKG/wasm/"
cp "$SLEIGH_HOME"/* "$STAGE/sleigh/"
cp "$SLEIGH_HOME"/* "$PKG/sleigh/"
echo "decompiler: $(ls -la "$PKG/wasm/decompile.wasm" | awk '{print $5}') bytes; $(ls "$PKG/sleigh" | wc -l) sleigh files"
echo "build-decompiler.sh: OK"
