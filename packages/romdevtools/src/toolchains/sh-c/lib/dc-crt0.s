	.section .text.start, "ax"
	.global _start
_start:
	mov.l stack_top, r15      ! stack = top of 16MB DC RAM
	mov.l bss_start, r0       ! clear .bss
	mov.l bss_end, r1
	mov #0, r2
1:	cmp/hs r1, r0
	bt 2f
	mov.l r2, @r0
	add #4, r0
	bra 1b
	nop
2:	mov.l main_addr, r0       ! call main()
	jsr @r0
	nop
hang:	bra hang
	nop
	.align 4
stack_top:	.long 0x8d000000
bss_start:	.long __bss_start
bss_end:	.long _end
main_addr:	.long _main
