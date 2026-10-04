# romdev: the two stack functions romdev's libco backend calls
# (scripts/patches/libco-wasm/libco-wasm.c), for a chip unit, which has no
# emscripten runtime: the same as emscripten's system/lib/compiler-rt/stack_ops.S.

.globaltype __stack_pointer, i32

.globl _emscripten_stack_restore
_emscripten_stack_restore:
  .functype _emscripten_stack_restore (i32) -> ()
  local.get 0
  global.set __stack_pointer
  end_function

.globl emscripten_stack_get_current
emscripten_stack_get_current:
  .functype emscripten_stack_get_current () -> (i32)
  global.get __stack_pointer
  end_function
