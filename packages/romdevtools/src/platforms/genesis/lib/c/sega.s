| ── sega.s — minimum Genesis crt0 / reset handler / ROM header ──
|
| Original code. Provides:
|   - 256-byte vector table at $000000 (SSP + reset, plus 254 unused
|     vectors mirroring _start so an errant jump is still recoverable)
|   - Genesis ROM header at $000100..$0001FF (system name, copyright,
|     ROM size, region flags, etc. The TMSS-bypass write at $A14000
|     happens IN _start, not here)
|   - _start handler that initializes SSP, calls main(), parks the CPU
|
| The header values below match SGDK/marsdev conventions. Real projects
| customize ID strings + region flags. ROM size word (offsets $1A4..$1A7)
| is patched by post-link tooling (gen_postlink or marsdev's makemd) —
| we leave a placeholder.

	.text
	.globl	_vectors
	.globl	_start

| ──────────────────────────────────────────────────────────────────
| Vector table at $000000 — 256 bytes, all 32-bit pointers.
| ──────────────────────────────────────────────────────────────────
_vectors:
	.long	0x00FFE000        | initial SSP (stack at top of WRAM)
	.long	_start            | reset PC
	| Vectors 2..63 — 62 more 32-bit vectors fill out the 256-byte
	| ($100) vector table. Point them all at _start so a bus error
	| restarts the cart rather than locking up. Real projects
	| install vblank/hblank/level-N interrupt handlers here.
	.rept	62
	.long	_start
	.endr

| ──────────────────────────────────────────────────────────────────
| ROM header at $000100..$0001FF (256 bytes total).
| ──────────────────────────────────────────────────────────────────
_rom_header:
	.ascii	"SEGA MEGA DRIVE "        | $100..$10F  system name
	.ascii	"(C)ROMDEV 2026.MAY"      | $110..$121  copyright
	.byte	0,0                       | $122..$123  pad
	.ascii	"ROM-DEV-MCP C BUILD                             "  | $124..$153  domestic title (48 chars)
	.ascii	"ROM-DEV-MCP C BUILD                             "  | $154..$183  overseas title (48 chars)
	.ascii	"GM ROMDEV-01-00"         | $184..$192  serial number (game id + revision)
	.byte	0,0                       | $193..$194  checksum (patched later)
	.ascii	"J               "        | $195..$1A4  device support (joypad)
	.long	0x00000000                | $1A4..$1A7  ROM start
	.long	0x00100000                | $1A8..$1AB  ROM end  (1 MB; patcher fixes)
	.long	0x00FF0000                | $1AC..$1AF  RAM start
	.long	0x00FFFFFF                | $1B0..$1B3  RAM end
	.ascii	"            "            | $1B4..$1BF  SRAM info (none)
	.space	48, 0x20                  | $1C0..$1EF  modem info (none) — 48 spaces
	.ascii	"JUE             "        | $1F0..$1FF  region (Japan/US/Europe)

| ──────────────────────────────────────────────────────────────────
| Reset handler — runs first when the console powers on.
| ──────────────────────────────────────────────────────────────────
_start:
	move.w	#0x2700, %sr              | mask all interrupts
	move.l	#0x00FFE000, %sp          | init stack at top of WRAM

	| TMSS bypass: write "SEGA" to $A14000 to enable VDP access on
	| later console revisions. Older consoles ignore the write.
	move.l	#0x53454741, 0x00A14000   | "SEGA" — TMSS lock release

	| Set up .bss zeroing + .data copy here in a real runtime. For
	| the minimum-viable path we skip both — user code lives entirely
	| in .text + uses no .bss/.data.

	jsr	main                      | call C entry point
1:
	bra.s	1b                        | spin forever if main returns
