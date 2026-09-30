// SPDX-FileCopyrightText: 2024 RizinOrg <info@rizin.re>
// SPDX-License-Identifier: LGPL-3.0-only

// clang-format off
#ifndef RZ_DEBUG_PLUGINS_BUILD_H
#define RZ_DEBUG_PLUGINS_BUILD_H

#define RZ_DEBUG_STATIC_PLUGINS &rz_debug_plugin_bf, &rz_debug_plugin_bochs, &rz_debug_plugin_dmp, &rz_debug_plugin_gdb, &rz_debug_plugin_io, &rz_debug_plugin_null, &rz_debug_plugin_winkd, &rz_debug_plugin_qnx

extern RzDebugPlugin rz_debug_plugin_bf;
extern RzDebugPlugin rz_debug_plugin_bochs;
extern RzDebugPlugin rz_debug_plugin_dmp;
extern RzDebugPlugin rz_debug_plugin_gdb;
extern RzDebugPlugin rz_debug_plugin_io;
extern RzDebugPlugin rz_debug_plugin_null;
extern RzDebugPlugin rz_debug_plugin_winkd;
extern RzDebugPlugin rz_debug_plugin_qnx;
// clang-format on

#endif