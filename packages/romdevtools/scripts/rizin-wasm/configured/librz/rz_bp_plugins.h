// SPDX-FileCopyrightText: 2024 RizinOrg <info@rizin.re>
// SPDX-License-Identifier: LGPL-3.0-only

// clang-format off
#ifndef RZ_BP_PLUGINS_BUILD_H
#define RZ_BP_PLUGINS_BUILD_H

#define RZ_BP_STATIC_PLUGINS &rz_bp_plugin_arm, &rz_bp_plugin_bf, &rz_bp_plugin_mips, &rz_bp_plugin_ppc, &rz_bp_plugin_sh, &rz_bp_plugin_x86

extern RzBreakpointPlugin rz_bp_plugin_arm;
extern RzBreakpointPlugin rz_bp_plugin_bf;
extern RzBreakpointPlugin rz_bp_plugin_mips;
extern RzBreakpointPlugin rz_bp_plugin_ppc;
extern RzBreakpointPlugin rz_bp_plugin_sh;
extern RzBreakpointPlugin rz_bp_plugin_x86;
// clang-format on

#endif