/* ── tile_engine.c — GBC starter with a tile map + multiple rooms ──
 *
 * Single-screen-per-room layout (Adventure / Zelda-1 / Sokoban shape).
 *   - 20×18 BG map rendered from a `room[]` array
 *   - Walk a sprite around with the d-pad
 *   - Crossing the screen edge transitions to the next room
 *   - 3 hand-written rooms wired up; extend with more for a real game
 *
 * Boot order follows the GBC "must-do" sequence from
 * src/platforms/gbc/TROUBLESHOOTING.md — do not reorder.
 *
 * Tile data layout (8×8, 2bpp, 16 bytes per tile):
 *   tile 0 — blank          (always reserved so OAM Y=0 doesn't glitch)
 *   tile 1 — floor          (light)
 *   tile 2 — wall            (dark, solid outline)
 *   tile 3 — door             (different color)
 *   tile 4 — player sprite
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

/* ── Tile data ──────────────────────────────────────────────────── */
/* Each tile is 16 bytes: 8 rows × 2 bytes/row.
 * For row N, byte 2N has the LOW colour bits, byte 2N+1 has the HIGH.
 *   colour 0 = 0 bit lo, 0 bit hi  (transparent on sprites)
 *   colour 1 = 1 bit lo, 0 bit hi
 *   colour 2 = 0 bit lo, 1 bit hi
 *   colour 3 = 1 bit lo, 1 bit hi
 */
static const uint8_t tiles[5 * 16] = {
  /* tile 0: blank (all colour 0) */
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,

  /* tile 1: floor (all colour 1) */
  0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00,
  0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00,

  /* tile 2: wall (all colour 3) */
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,

  /* tile 3: door (colour 2 outline, colour 1 fill) */
  0xFF, 0xFF, 0x81, 0xFF, 0x81, 0xFF, 0x81, 0xFF,
  0x81, 0xFF, 0x81, 0xFF, 0x81, 0xFF, 0xFF, 0xFF,

  /* tile 4: player sprite (colour 3 outline, colour 0 fill) */
  0x3C, 0x3C, 0x42, 0x42, 0x81, 0x81, 0x81, 0x81,
  0x81, 0x81, 0x81, 0x81, 0x42, 0x42, 0x3C, 0x3C,
};

/* ── Palettes (BGR555) ──────────────────────────────────────────── */
/* CGB palette layout: 8 BG palettes × 4 colours × 2 bytes = 64 bytes.
 * BCPS bit 7 = auto-increment; bits 5..3 = palette; bits 2..1 = colour;
 * bit 0 = byte select (lo/hi). 0x80 = "palette 0, colour 0, byte 0, auto-increment". */
static const uint16_t bg_pal[4] = {
  0x7FFF,  /* 0: white */
  0x3DEF,  /* 1: pale yellow (floor) */
  0x4210,  /* 2: dark grey (door outline) */
  0x0C63,  /* 3: dark grey (wall) */
};

/* Sprite palette — single 4-colour palette in OBJ palette 0. */
static const uint16_t obj_pal[4] = {
  0x7FFF,  /* 0: transparent */
  0x001F,  /* 1: red */
  0x03E0,  /* 2: green */
  0x7C00,  /* 3: blue (player outline) */
};

/* ── Rooms ──────────────────────────────────────────────────────── */
/* 20 columns × 18 rows. Tile index per cell.
 * Edges are walls (tile 2). One door per side leads to the next room. */
#define COLS 20
#define ROWS 18
#define ROOMS 3

static const uint8_t rooms[ROOMS][ROWS * COLS] = {
  /* Room 0: a corridor — door on right */
  {
    2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,3,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,3,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,
  },
  /* Room 1: open hall — doors left and right */
  {
    2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,2,2,2,2,2,2,2,2,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    3,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,3,
    3,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,3,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,2,2,2,2,2,2,2,2,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,
  },
  /* Room 2: end room — door on left only */
  {
    2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,2,2,2,2,2,1,1,1,1,2,2,2,2,2,1,1,2,
    2,1,1,2,1,1,1,2,1,1,1,1,2,1,1,1,2,1,1,2,
    2,1,1,2,1,1,1,2,1,1,1,1,2,1,1,1,2,1,1,2,
    2,1,1,2,2,1,2,2,1,1,1,1,2,2,1,2,2,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    3,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    3,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,2,2,1,2,2,1,1,1,1,2,2,1,2,2,1,1,2,
    2,1,1,2,1,1,1,2,1,1,1,1,2,1,1,1,2,1,1,2,
    2,1,1,2,1,1,1,2,1,1,1,1,2,1,1,1,2,1,1,2,
    2,1,1,2,2,2,2,2,1,1,1,1,2,2,2,2,2,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,
    2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,
  },
};

/* ── Helpers ────────────────────────────────────────────────────── */
static void copy_to_vram(uint8_t *dst, const uint8_t *src, uint16_t n) {
  /* Delegate to the runtime's pointer-walk copy — an indexed dst[i]=src[i]
   * loop into VRAM is miscompiled by SDCC sm83. */
  memcpy_vram(dst, src, n);
}

static void load_bg_palette(void) {
  uint8_t i;
  BCPS = 0x80;  /* palette 0, colour 0, lo byte, auto-increment */
  for (i = 0; i < 4; i++) {
    BCPD = (uint8_t)(bg_pal[i] & 0xFF);
    BCPD = (uint8_t)((bg_pal[i] >> 8) & 0xFF);
  }
}

static void load_obj_palette(void) {
  uint8_t i;
  OCPS = 0x80;
  for (i = 0; i < 4; i++) {
    OCPD = (uint8_t)(obj_pal[i] & 0xFF);
    OCPD = (uint8_t)((obj_pal[i] >> 8) & 0xFF);
  }
}

static void render_room(uint8_t room_idx) {
  /* Write the 20×18 map into BG map 1 at $9800. The hardware BG map is
   * 32 tiles wide, so each game row spans 32 bytes in VRAM but we only
   * use the first 20. */
  uint16_t i, j;
  uint8_t *bg_map = (uint8_t *)0x9800;
  const uint8_t *room = rooms[room_idx];
  for (j = 0; j < ROWS; j++) {
    for (i = 0; i < COLS; i++) {
      bg_map[j * 32 + i] = room[j * COLS + i];
    }
  }
}

/* Returns true if the tile at (tx, ty) in the current room is solid. */
static uint8_t solid(uint8_t room_idx, uint8_t tx, uint8_t ty) {
  uint8_t t;
  if (tx >= COLS || ty >= ROWS) return 1;
  t = rooms[room_idx][ty * COLS + tx];
  return (t == 2);  /* tile 2 = wall */
}

/* Returns true if the tile at (tx, ty) is a door. */
static uint8_t is_door(uint8_t room_idx, uint8_t tx, uint8_t ty) {
  uint8_t t;
  if (tx >= COLS || ty >= ROWS) return 0;
  t = rooms[room_idx][ty * COLS + tx];
  return (t == 3);
}

void main(void) {
  uint8_t px = 80;        /* player screen X (hardware = +8) */
  uint8_t py = 72;        /* player screen Y (hardware = +16) */
  uint8_t current_room = 0;
  uint8_t pad;
  uint8_t nx, ny;
  uint8_t tx, ty;

  /* ── 1. LCD off, safely ────────────────────────────────────────── */
  lcd_init_default();
  LCDC = 0;

  /* ── 2. Upload tile data to VRAM slot 0 ($8000) ────────────────── */
  copy_to_vram((uint8_t *)0x8000, tiles, sizeof(tiles));

  /* ── 3. Palettes ───────────────────────────────────────────────── */
  load_bg_palette();
  load_obj_palette();

  /* ── 4. Render starting room ───────────────────────────────────── */
  render_room(current_room);

  /* ── 5. Build initial OAM ──────────────────────────────────────── */
  oam_clear();
  oam_set(0, (uint8_t)(py + 16), (uint8_t)(px + 8), 4, 0);

  /* ── 6. LCD back on with BG + OBJ ──────────────────────────────── */
  LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;

  /* ── 7. Game loop ──────────────────────────────────────────────── */
  for (;;) {
    wait_vblank();
    oam_dma_flush();
    pad = joypad_read();

    /* Tentative new position. */
    nx = px;
    ny = py;
    if (pad & PAD_LEFT)  nx--;
    if (pad & PAD_RIGHT) nx++;
    if (pad & PAD_UP)    ny--;
    if (pad & PAD_DOWN)  ny++;

    /* Tile under the player's centre (player is 8×8). */
    tx = (uint8_t)(nx >> 3);
    ty = (uint8_t)(ny >> 3);

    /* Door — transition to neighbouring room. */
    if (is_door(current_room, tx, ty)) {
      if (nx >= 152) {        /* right edge → next room */
        if (current_room < ROOMS - 1) {
          current_room++;
          px = 4;             /* enter at left side */
          py = ny;
          LCDC = 0;
          render_room(current_room);
          LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;
          oam_set(0, (uint8_t)(py + 16), (uint8_t)(px + 8), 4, 0);
          continue;
        }
      } else if (nx <= 4) {   /* left edge → previous room */
        if (current_room > 0) {
          current_room--;
          px = 148;            /* enter at right side */
          py = ny;
          LCDC = 0;
          render_room(current_room);
          LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;
          oam_set(0, (uint8_t)(py + 16), (uint8_t)(px + 8), 4, 0);
          continue;
        }
      }
    }

    /* Wall collision — block movement. */
    if (!solid(current_room, tx, ty)) {
      px = nx;
      py = ny;
    }

    oam_set(0, (uint8_t)(py + 16), (uint8_t)(px + 8), 4, 0);
  }
}
