// SPDX-FileCopyrightText: 2024 RizinOrg <info@rizin.re>
// SPDX-License-Identifier: LGPL-3.0-only

// clang-format off
#ifndef RZ_CRYPTO_PLUGINS_BUILD_H
#define RZ_CRYPTO_PLUGINS_BUILD_H

#define RZ_CRYPTO_STATIC_PLUGINS &rz_crypto_plugin_aes, &rz_crypto_plugin_aes_cbc, &rz_crypto_plugin_base64, &rz_crypto_plugin_base91, &rz_crypto_plugin_blowfish, &rz_crypto_plugin_cps2, &rz_crypto_plugin_des, &rz_crypto_plugin_punycode, &rz_crypto_plugin_rc2, &rz_crypto_plugin_rc4, &rz_crypto_plugin_rc6, &rz_crypto_plugin_rol, &rz_crypto_plugin_ror, &rz_crypto_plugin_rot, &rz_crypto_plugin_serpent, &rz_crypto_plugin_xor, &rz_crypto_plugin_sm4_ecb

extern RzCryptoPlugin rz_crypto_plugin_aes;
extern RzCryptoPlugin rz_crypto_plugin_aes_cbc;
extern RzCryptoPlugin rz_crypto_plugin_base64;
extern RzCryptoPlugin rz_crypto_plugin_base91;
extern RzCryptoPlugin rz_crypto_plugin_blowfish;
extern RzCryptoPlugin rz_crypto_plugin_cps2;
extern RzCryptoPlugin rz_crypto_plugin_des;
extern RzCryptoPlugin rz_crypto_plugin_punycode;
extern RzCryptoPlugin rz_crypto_plugin_rc2;
extern RzCryptoPlugin rz_crypto_plugin_rc4;
extern RzCryptoPlugin rz_crypto_plugin_rc6;
extern RzCryptoPlugin rz_crypto_plugin_rol;
extern RzCryptoPlugin rz_crypto_plugin_ror;
extern RzCryptoPlugin rz_crypto_plugin_rot;
extern RzCryptoPlugin rz_crypto_plugin_serpent;
extern RzCryptoPlugin rz_crypto_plugin_xor;
extern RzCryptoPlugin rz_crypto_plugin_sm4_ecb;
// clang-format on

#endif