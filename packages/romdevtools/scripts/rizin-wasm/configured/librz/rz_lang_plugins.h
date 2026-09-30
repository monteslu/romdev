// SPDX-FileCopyrightText: 2024 RizinOrg <info@rizin.re>
// SPDX-License-Identifier: LGPL-3.0-only

// clang-format off
#ifndef RZ_LANG_PLUGINS_BUILD_H
#define RZ_LANG_PLUGINS_BUILD_H

#define RZ_LANG_STATIC_PLUGINS &rz_lang_plugin_lib, &rz_lang_plugin_pipe, &rz_lang_plugin_c, &rz_lang_plugin_cpipe

extern RzLangPlugin rz_lang_plugin_lib;
extern RzLangPlugin rz_lang_plugin_pipe;
extern RzLangPlugin rz_lang_plugin_c;
extern RzLangPlugin rz_lang_plugin_cpipe;
// clang-format on

#endif