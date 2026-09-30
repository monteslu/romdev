	.file	2 "blitrow.c"
	.option	pic2
	.text
	.align	2
	.globl	blitRow
	.loc	2	195
 #   195	void blitRow(struct Row *row, s32 count) {
	.ent	blitRow 2
blitRow:
	.frame	$sp, 0, $31
	.mask	0x00000000, 0
	.fmask	0x00000000, 0
	.loc	2	200
 #   200	    s32 *dst = row->dst;
	lw	$t0, 0($a0)
	.loc	2	201
 #   201	    s32 *src = row->src;
	lw	$t1, 4($a0)
	.loc	2	206
 #   206	    row->count = count;
	sw	$a1, 12($a0)
	.loc	2	211
 #   211	    row->limit = BLIT_LIMIT;
	lui	$t2, 0x1234
	ori	$t2, $t2, 0x5678
	sw	$t2, 16($a0)
	.loc	2	220
 #   220	    row->sum = (row->head + row->tail) + (row->lo + row->hi);
	lw	$t3, 20($a0)
	lw	$t4, 24($a0)
	lw	$t5, 28($a0)
	lw	$t6, 32($a0)
	addu	$t7, $t3, $t4
	addu	$t8, $t5, $t6
	addu	$t9, $t7, $t8
	sw	$t9, 36($a0)
$32:
	.loc	2	224
 #   224	    row->ready = 1;
	li	$v0, 1
	sw	$v0, 40($a0)
	.livereg	0x0000FF0E,0x00000000
	.loc	2	228
 #   228	    row->next = row->prev;
	lw	$v1, 44($a0)
	sw	$v1, 48($a0)
	.loc	2	230
 #   230	}
	jr	$ra
	.end	blitRow
