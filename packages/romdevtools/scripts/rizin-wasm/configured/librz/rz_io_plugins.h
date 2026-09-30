// SPDX-FileCopyrightText: 2024 RizinOrg <info@rizin.re>
// SPDX-License-Identifier: LGPL-3.0-only

// clang-format off
#ifndef RZ_IO_PLUGINS_BUILD_H
#define RZ_IO_PLUGINS_BUILD_H

#define RZ_IO_STATIC_PLUGINS &rz_io_plugin_ar, &rz_io_plugin_fd, &rz_io_plugin_bfdbg, &rz_io_plugin_bochs, &rz_io_plugin_debug, &rz_io_plugin_default, &rz_io_plugin_dmp, &rz_io_plugin_gdb, &rz_io_plugin_gzip, &rz_io_plugin_http, &rz_io_plugin_ihex, &rz_io_plugin_srec, &rz_io_plugin_mach, &rz_io_plugin_malloc, &rz_io_plugin_null, &rz_io_plugin_procpid, &rz_io_plugin_ptrace, &rz_io_plugin_rzpipe, &rz_io_plugin_rzweb, &rz_io_plugin_self, &rz_io_plugin_shm, &rz_io_plugin_sparse, &rz_io_plugin_tcp, &rz_io_plugin_winkd, &rz_io_plugin_winedbg, &rz_io_plugin_zip, &rz_io_plugin_qnx

extern RzIOPlugin rz_io_plugin_ar;
extern RzIOPlugin rz_io_plugin_fd;
extern RzIOPlugin rz_io_plugin_bfdbg;
extern RzIOPlugin rz_io_plugin_bochs;
extern RzIOPlugin rz_io_plugin_debug;
extern RzIOPlugin rz_io_plugin_default;
extern RzIOPlugin rz_io_plugin_dmp;
extern RzIOPlugin rz_io_plugin_gdb;
extern RzIOPlugin rz_io_plugin_gzip;
extern RzIOPlugin rz_io_plugin_http;
extern RzIOPlugin rz_io_plugin_ihex;
extern RzIOPlugin rz_io_plugin_srec;
extern RzIOPlugin rz_io_plugin_mach;
extern RzIOPlugin rz_io_plugin_malloc;
extern RzIOPlugin rz_io_plugin_null;
extern RzIOPlugin rz_io_plugin_procpid;
extern RzIOPlugin rz_io_plugin_ptrace;
extern RzIOPlugin rz_io_plugin_rzpipe;
extern RzIOPlugin rz_io_plugin_rzweb;
extern RzIOPlugin rz_io_plugin_self;
extern RzIOPlugin rz_io_plugin_shm;
extern RzIOPlugin rz_io_plugin_sparse;
extern RzIOPlugin rz_io_plugin_tcp;
extern RzIOPlugin rz_io_plugin_winkd;
extern RzIOPlugin rz_io_plugin_winedbg;
extern RzIOPlugin rz_io_plugin_zip;
extern RzIOPlugin rz_io_plugin_qnx;
// clang-format on

#endif