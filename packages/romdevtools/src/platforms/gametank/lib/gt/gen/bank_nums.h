// romdev single-bank GameTank: there is ONE fixed ROM bank ($FF). The SDK runtime
// change_rom_bank()s into asset banks (LOADERS/COMMON/PROG/SAVE) to fetch sprite/
// text/audio data; with everything in the single 32K bank, they all resolve to the
// same bank, so the banking is effectively a no-op. (BANK_PROG0 is the alias some
// modules use for the program bank.)
#define BANK_ROM     0xFF
#define BANK_LOADERS 0xFF
#define BANK_COMMON  0xFF
#define BANK_PROG    0xFF
#define BANK_PROG0   0xFF
#define BANK_SAVE    0xFE
