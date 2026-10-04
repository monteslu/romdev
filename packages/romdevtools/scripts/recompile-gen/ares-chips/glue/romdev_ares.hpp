/* romdev: the <ares/ares.hpp> that ares's two firmware-coprocessor cores
 * (component/processor/upd96050 and component/processor/arm7tdmi) are
 * compiled against when they run outside ares (a recompiled cart's chip unit,
 * the snes9x core). The build puts this file first on the include path as
 * ares/ares.hpp, so the processor sources compile exactly as they are.
 *
 * ares's own ares/ares.hpp is the whole emulator's umbrella (libco, sljit,
 * the VFS, the node tree, the platform interface, ...). The two processors use
 * only what is kept here, in ares's order: nall's platform, memory, literals,
 * serializer, string and traits, `using namespace nall`, the `register`
 * macro, and ares/types.hpp (the n8 / n16 / i16 / ... integer types). Nothing
 * of ares is re-declared; every line below names an ares or nall header.
 *
 * ares (and nall) are ISC-licensed: Copyright (c) 2004-2025 ares team, Near
 * et al. This file is romdev's. */
#pragma once

#include <vector>
#include <functional>
#include <span>

#include <nall/platform.hpp>
#include <nall/memory.hpp>
#include <nall/literals.hpp>
#include <nall/serializer.hpp>
#include <nall/string.hpp>
#include <nall/traits.hpp>
using namespace nall;
using namespace nall::primitives;

/* ares/ares.hpp: ares uses `register` as an identifier */
#define register $register

#include <ares/types.hpp>
