#ifndef SPP_CONFIG_H
#define SPP_CONFIG_H

// clang-format off
#define HAVE_SYSTEM                 1
#define HAVE_FORK                   1
// clang-format on

#if HAVE_SYSTEM
#include "p/sh.h"
#endif

#include "p/spp.h"
#include "p/cpp.h"

struct Proc *procs[] = {
	&spp_proc,
	&cpp_proc,
#if HAVE_SYSTEM
	&sh_proc,
#endif
	NULL
};

DEFAULT_PROC(spp)

#endif
