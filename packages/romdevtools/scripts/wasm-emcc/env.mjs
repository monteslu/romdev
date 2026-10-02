// env.mjs - building.get_building_env() for the wasm-emcc toolchain: the
// environment emmake / emconfigure run a build system under.
import path from "node:path";
import { locate } from "./emcc.mjs";

export function buildingEnv(base = process.env) {
  const { emRoot, sysroot } = locate();
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "bin");
  return {
    ...base,
    CC: path.join(bin, "emcc"), CXX: path.join(bin, "em++"), AR: path.join(bin, "emar"), LD: path.join(bin, "emcc"),
    NM: path.join(bin, "llvm-nm"), LDSHARED: path.join(bin, "emcc"), RANLIB: path.join(bin, "emranlib"),
    EMSCRIPTEN_TOOLS: path.join(emRoot, "tools"), HOST_CFLAGS: "-W", HOST_CXXFLAGS: "-W",
    PKG_CONFIG_LIBDIR: path.join(sysroot, "local/lib/pkgconfig") + path.delimiter + path.join(sysroot, "lib/pkgconfig"),
    PKG_CONFIG_PATH: base.EM_PKG_CONFIG_PATH ?? "", EMSCRIPTEN: emRoot,
    PATH: bin + path.delimiter + path.join(sysroot, "bin") + path.delimiter + base.PATH,
    ACLOCAL_PATH: path.join(sysroot, "share/aclocal"),
  };
}
