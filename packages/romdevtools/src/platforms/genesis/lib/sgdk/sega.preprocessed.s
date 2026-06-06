
.section .text.keepboot

*-------------------------------------------------------
*
* Sega startup code for the GNU Assembler
* Translated from:
* Sega startup code for the Sozobon C compiler
* Written by Paul W. Lee
* Modified by Charles Coty
* Modified by Stephane Dallongeville
*
*-------------------------------------------------------

    .globl rom_header

    .org 0x00000000

_Start_Of_Rom:
_Vecteurs_68K:
        dc.l __stack
        dc.l _Entry_Point
        dc.l _Bus_Error
        dc.l _Address_Error
        dc.l _Illegal_Instruction
        dc.l _Zero_Divide
        dc.l _Chk_Instruction
        dc.l _Trapv_Instruction
        dc.l _Privilege_Violation
        dc.l _Trace
        dc.l _Line_1010_Emulation
        dc.l _Line_1111_Emulation
        dc.l _Error_Exception, _Error_Exception, _Error_Exception, _Error_Exception
        dc.l _Error_Exception, _Error_Exception, _Error_Exception, _Error_Exception
        dc.l _Error_Exception, _Error_Exception, _Error_Exception, _Error_Exception
        dc.l _Error_Exception
        dc.l _INT
        dc.l _EXTINT
        dc.l _INT
        dc.l hintCaller
        dc.l _INT
        dc.l _VINT
        dc.l _INT
        dc.l _trap_0
        dc.l _INT,_INT,_INT,_INT,_INT,_INT,_INT
        dc.l _INT,_INT,_INT,_INT,_INT,_INT,_INT,_INT
        dc.l _INT,_INT,_INT,_INT,_INT,_INT,_INT,_INT
        dc.l _INT,_INT,_INT,_INT,_INT,_INT,_INT,_INT

rom_header:
        .incbin "out/rom_header.bin", 0, 0x100

_Entry_Point:
* disable interrupts
        move #0x2700,%sr

* Configure a 512 bytes user stack at bottom, and system stack on top of it
        move %sp, %usp
        sub #512, %sp

* Halt Z80 (need to be done as soon as possible on reset)
        move.l #0xA11100,%a0
        move.w #0x0100,%d0
        move.w %d0,(%a0)
        move.w %d0,0x0100(%a0)

        tst.l 0xa10008
        bne.s SkipInit

        tst.w 0xa1000c
        bne.s SkipInit

* Check Version Number
        move.b -0x10ff(%a0),%d0
        andi.b #0x0f,%d0
        beq.s NoTMSS

* Sega Security Code (SEGA)
        move.l #0x53454741,0x2f00(%a0)

NoTMSS:
        jmp _start_entry

SkipInit:
        jmp _reset_entry


*------------------------------------------------
*
* interrupt functions
*
*------------------------------------------------

_INT:
        movem.l %d0-%d1/%a0-%a1,-(%sp)
        move.l intCB, %a0
        jsr (%a0)
        movem.l (%sp)+,%d0-%d1/%a0-%a1
        rte

_EXTINT:
        movem.l %d0-%d1/%a0-%a1,-(%sp)
        move.l eintCB, %a0
        jsr (%a0)
        movem.l (%sp)+,%d0-%d1/%a0-%a1
        rte

_VINT:
        btst #5, (%sp)
        bne.s no_user_task

        tst.w task_lock
        bne.s 1f
        move.w #0, -(%sp)
        bra.s unlock

1:
        bcs.s no_user_task
        subq.w #1, task_lock
        bne.s no_user_task
        move.w #1, -(%sp)

unlock:

        move.l %a0, task_regs
        lea (task_regs + (15 * 4)), %a0
        movem.l %d0-%d7/%a1-%a6, -(%a0)

        move.w (%sp)+, %d0

        move.w (%sp)+, task_sr
        move.l (%sp)+, task_pc
        movem.l (%sp)+, %d2-%d7/%a2-%a6

no_user_task:





        movem.l %d0-%d1/%a0-%a1,-(%sp)
        ori.w #0x0001, intTrace
        addq.l #1, vtimer

        move.l z80VIntCB, %a0
        jsr (%a0)

        btst #1, VBlankProcess+1
        beq.s no_bmp_task

        jsr BMP_doVBlankProcess

no_bmp_task:
        move.l vintCB, %a0
        jsr (%a0)
        andi.w #0xFFFE, intTrace
        movem.l (%sp)+,%d0-%d1/%a0-%a1
        rte

*------------------------------------------------
*
* Copyright (c) 1988 by Sozobon, Limited. Author: Johann Ruegg
*
* Permission is granted to anyone to use this software for any purpose
* on any computer system, and to redistribute it freely, with the
* following restrictions:
* 1) No charge may be made other than reasonable charges for reproduction.
* 2) Modified versions must be clearly marked as such.
* 3) The authors are not responsible for any harmful consequences
* of using this software, even if they result from defects in it.
*
*------------------------------------------------

ldiv:
        move.l 4(%a7),%d0
        bpl ld1
        neg.l %d0
ld1:
        move.l 8(%a7),%d1
        bpl ld2
        neg.l %d1
        eor.b #0x80,4(%a7)
ld2:
        bsr i_ldiv
        tst.b 4(%a7)
        bpl ld3
        neg.l %d0
ld3:
        rts

lmul:
        move.l 4(%a7),%d0
        bpl lm1
        neg.l %d0
lm1:
        move.l 8(%a7),%d1
        bpl lm2
        neg.l %d1
        eor.b #0x80,4(%a7)
lm2:
        bsr i_lmul
        tst.b 4(%a7)
        bpl lm3
        neg.l %d0
lm3:
        rts

lrem:
        move.l 4(%a7),%d0
        bpl lr1
        neg.l %d0
lr1:
        move.l 8(%a7),%d1
        bpl lr2
        neg.l %d1
lr2:
        bsr i_ldiv
        move.l %d1,%d0
        tst.b 4(%a7)
        bpl lr3
        neg.l %d0
lr3:
        rts

ldivu:
        move.l 4(%a7),%d0
        move.l 8(%a7),%d1
        bsr i_ldiv
        rts

lmulu:
        move.l 4(%a7),%d0
        move.l 8(%a7),%d1
        bsr i_lmul
        rts

lremu:
        move.l 4(%a7),%d0
        move.l 8(%a7),%d1
        bsr i_ldiv
        move.l %d1,%d0
        rts
*
* A in d0, B in d1, return A*B in d0
*
i_lmul:
        move.l %d3,%a2
        move.w %d1,%d2
        mulu %d0,%d2

        move.l %d1,%d3
        swap %d3
        mulu %d0,%d3

        swap %d0
        mulu %d1,%d0

        add.l %d3,%d0
        swap %d0
        clr.w %d0

        add.l %d2,%d0
        move.l %a2,%d3
        rts
*
*A in d0, B in d1, return A/B in d0, A%B in d1
*
i_ldiv:
        tst.l %d1
        bne nz1

* divide by zero
* divu #0,%d0
        move.l #0x80000000,%d0
        move.l %d0,%d1
        rts
nz1:
        move.l %d3,%a2
        cmp.l %d1,%d0
        bhi norm
        beq is1
* A<B, so ret 0, rem A
        move.l %d0,%d1
        clr.l %d0
        move.l %a2,%d3
        rts
* A==B, so ret 1, rem 0
is1:
        moveq.l #1,%d0
        clr.l %d1
        move.l %a2,%d3
        rts
* A>B and B is not 0
norm:
        cmp.l #1,%d1
        bne not1
* B==1, so ret A, rem 0
        clr.l %d1
        move.l %a2,%d3
        rts
* check for A short (implies B short also)
not1:
        cmp.l #0xffff,%d0
        bhi slow
* A short and B short -- use 'divu'
        divu %d1,%d0
        swap %d0
        clr.l %d1
        move.w %d0,%d1
        clr.w %d0
        swap %d0
        move.l %a2,%d3
        rts
* check for B short
slow:
        cmp.l #0xffff,%d1
        bhi slower
* A long and B short -- use special stuff from gnu
        move.l %d0,%d2
        clr.w %d2
        swap %d2
        divu %d1,%d2
        clr.l %d3
        move.w %d2,%d3
        swap %d3

        move.w %d0,%d2
        divu %d1,%d2

        move.l %d2,%d1
        clr.w %d1
        swap %d1

        clr.l %d0
        move.w %d2,%d0
        add.l %d3,%d0
        move.l %a2,%d3
        rts
* A>B, B > 1
slower:
        move.l #1,%d2
        clr.l %d3
moreadj:
        cmp.l %d0,%d1
        bhs adj
        add.l %d2,%d2
        add.l %d1,%d1
        bpl moreadj
* we shifted B until its >A or sign bit set
* we shifted #1 (d2) along with it
adj:
        cmp.l %d0,%d1
        bhi ltuns
        or.l %d2,%d3
        sub.l %d1,%d0
ltuns:
        lsr.l #1,%d1
        lsr.l #1,%d2
        bne adj
* d3=answer, d0=rem
        move.l %d0,%d1
        move.l %d3,%d0
        move.l %a2,%d3
        rts
