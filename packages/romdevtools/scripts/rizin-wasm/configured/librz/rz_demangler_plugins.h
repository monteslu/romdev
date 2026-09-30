// SPDX-FileCopyrightText: 2024 RizinOrg <info@rizin.re>
// SPDX-License-Identifier: LGPL-3.0-only

// clang-format off
#ifndef RZ_DEMANGLER_PLUGINS_BUILD_H
#define RZ_DEMANGLER_PLUGINS_BUILD_H

#define RZ_DEMANGLER_STATIC_PLUGINS &rz_demangler_plugin_java, &rz_demangler_plugin_msvc, &rz_demangler_plugin_objc, &rz_demangler_plugin_pascal, &rz_demangler_plugin_cpp, &rz_demangler_plugin_rust, &rz_demangler_plugin_swift

extern RzDemanglerPlugin rz_demangler_plugin_java;
extern RzDemanglerPlugin rz_demangler_plugin_msvc;
extern RzDemanglerPlugin rz_demangler_plugin_objc;
extern RzDemanglerPlugin rz_demangler_plugin_pascal;
extern RzDemanglerPlugin rz_demangler_plugin_cpp;
extern RzDemanglerPlugin rz_demangler_plugin_rust;
extern RzDemanglerPlugin rz_demangler_plugin_swift;
// clang-format on

#endif