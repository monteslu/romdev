/* Minimal N64 IPL3 (clean-room): runs in SP DMEM at 0xA4000040 after the HLE/real
   PIF boot copies ROM[0x40..0xFFF] here. Its job: PI-DMA the game from cart
   (0xB0001000) to RDRAM (0x80000400), then jump to the game entry. Assembled to
   the 0xFC0-byte IPL3 slot. */
    .set noreorder
    .set noat
    .global ipl3_start
ipl3_start:
    /* PI DMA: copy GAME_SIZE bytes from cart 0x10001000 to RDRAM 0x00000400 */
    lui   $t0, 0xA460             /* PI base 0xA4600000 */
    /* PI_DRAM_ADDR = 0x00000400 (RDRAM dest, phys) */
    li    $t1, 0x00000400
    sw    $t1, 0x00($t0)          /* PI_DRAM_ADDR_REG */
    /* PI_CART_ADDR = 0x10001000 (cart src, phys; game starts at ROM 0x1000) */
    lui   $t1, 0x1000
    ori   $t1, $t1, 0x1000
    sw    $t1, 0x04($t0)          /* PI_CART_ADDR_REG */
    /* PI_WR_LEN = GAME_SIZE-1 (write to RDRAM) */
    li    $t1, (GAME_SIZE - 1)
    sw    $t1, 0x0C($t0)          /* PI_WR_LEN_REG starts the DMA */
1:  /* wait for PI not busy (PI_STATUS bit0/1) */
    lw    $t2, 0x10($t0)
    andi  $t2, $t2, 0x3
    bnez  $t2, 1b
    nop
    /* jump to the game entry in RDRAM (cached kseg0) */
    lui   $t3, 0x8000
    ori   $t3, $t3, 0x0400
    jr    $t3
    nop
