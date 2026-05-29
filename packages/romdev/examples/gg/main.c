// Minimal SMS ROM. SDCC's stock crt0 boots into Z80 mode; we don't
// initialize the VDP (a real SMS ROM would call SMS_init / SMS_loadTiles
// from devkitSMS). This proves the toolchain pipeline works end-to-end:
// build → load → run → screenshot. The framebuffer will likely be black
// or whatever the VDP defaults to.
unsigned char counter;
void main(void) {
  counter = 42;
  for (;;) counter++;
}
