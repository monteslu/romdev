/* Definitions every compiled chip unit needs (the objects snes9x keeps in
 * globals.cpp / memmap.cpp), shared by the glue files. */
#include "snes9x.h"
#include "memmap.h"

CMemory			Memory;
struct SMulti		Multi;
struct SSettings	Settings;
struct SSNESGameFixes	SNESGameFixes;
uint8			OpenBus;

extern "C" int printf (const char *, ...) { return 0; }

/* the cart's data bus, before a call whose result can be it */
extern "C" void romdev_set_openbus (int v) { OpenBus = (uint8) v; }
