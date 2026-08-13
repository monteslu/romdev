-- glstress - a GL fixture with the three properties that catch the bugs
-- glcart.wasc structurally cannot express.
--
-- Built for romdev's fixture corpus after five bugs in a row were found by
-- real game carts and missed by the 64x64 fixture. The romdev dev named
-- the shape: "a cart that renders ABOVE the window size, re-sets its
-- viewport per frame, and builds an MRT target. One cart with those three
-- properties would have caught four of the five."
--
-- The three properties, and which bug each expresses:
--
--   1. CART RESOLUTION > WINDOW (1920x1080 vs a smaller window)
--      -> the corner render, and the window-resize clamp. A fixture at
--         64x64 is always smaller than its window, so neither can happen.
--
--   2. VIEWPORT RE-SET EVERY FRAME (love.graphics.setScissor here)
--      -> the GL-state leak. A cart that sets state once at load cannot
--         notice that something else clobbered it mid-run.
--
--   3. AN MRT / CUBEMAP TARGET
--      -> the shared-context claim bug (2f891b74) and the teardown
--         poisoning. Both fail attachment VALIDATION, which a single plain
--         colour canvas never reaches. This is the property that made
--         3DreamEngine carts the only thing that could see them.
--
-- HOW TO ASSERT ON IT: read wasm({op:'debugState'}) -- `ok` is 1 only when
-- every stage completed this frame. DO NOT assert on screenshot pixels:
-- this cart paints its background before the MRT stage, so a non-black
-- check reads PASSING on a broken frame. That trap cost two rounds.
--
-- AND WARM UP: the shared-context bug damages exactly the FIRST load after
-- a presentWindow load. A single trial on a fresh server passes. Run a
-- warm-up load, or ten trials.

local W, H = 1920, 1080

local mrt = {}        -- the multiple render targets
local cube            -- a cubemap target
local ok = 0          -- 1 when every stage completed this frame
local stages = 0      -- bitfield of what completed, for diagnosis
local frame = 0

-- The engine exposes two cart-writable debug slots, read back through
-- wasm({op:'debugState'}) as `score` and `aux`:
--
--   score (slot 0) = ok      1 only when EVERY stage completed this frame
--   aux   (slot 1) = stages  bitfield, so a failure says WHICH stage died
--
-- Assert on `score`. `lua_ok` alone is not enough: a pcall'd MRT failure
-- leaves the cart running happily with a half-drawn frame.

function love.load()
  -- PROPERTY 3: an MRT set plus a cubemap. These are the demanding
  -- attachments -- the ones whose completeness check actually validates
  -- against the current context.
  -- BOTH must be GPU-only formats. An "rgba8" canvas is CPU-backed here
  -- and the engine refuses it as an MRT attachment (correctly, and with a
  -- clear message) -- which would make this fixture fail for a reason
  -- that has nothing to do with the bug it is meant to catch.
  mrt[1] = love.graphics.newCanvas(512, 512, { format = "rgba16f" })
  mrt[2] = love.graphics.newCanvas(512, 512, { format = "rgba16f" })
  cube   = love.graphics.newCanvas(256, 256, { type = "cube" })
end

function love.draw()
  frame = frame + 1
  stages = 0
  local g = love.graphics

  -- PROPERTY 2: re-set the viewport/scissor EVERY frame, so a leak from
  -- another context or another cart shows up as clipped output rather
  -- than being masked by state set once at load.
  g.setScissor(0, 0, W, H)
  g.clear(0.05, 0.07, 0.12)
  stages = stages | 1

  -- background FIRST and deliberately: this is what makes a pixel-based
  -- check lie. The frame has content even when every stage below fails.
  g.setColor(0.2, 0.4, 0.8)
  g.rectangle("fill", 40, 40, W - 80, H - 80)
  stages = stages | 2

  -- MRT pass. This is the one that fails when the FBO is validated
  -- against the wrong context.
  local okMrt, mrtErr = pcall(function()
    g.setCanvas({ mrt[1], mrt[2] })
    g.clear(0, 0, 0, 1)
    g.setColor(1, 1, 1)
    g.rectangle("fill", 10, 10, 100, 100)
    g.setCanvas()
  end)
  if okMrt then stages = stages | 4
  else
    g.setCanvas()
    if frame == 3 then print("MRT FAILED: " .. tostring(mrtErr)) end
  end

  -- cubemap face pass
  local okCube = pcall(function()
    for face = 1, 6 do
      g.setCanvas({ { cube, face = face } })
      g.clear(face / 6, 0.2, 1 - face / 6, 1)
    end
    g.setCanvas()
  end)
  if okCube then stages = stages | 8 else g.setCanvas() end

  -- composite the MRT results back, so the cart is visibly doing work
  g.setColor(1, 1, 1)
  if okMrt then g.draw(mrt[1], 60, 60) end
  stages = stages | 16

  -- PROPERTY 1: draw at the FAR EDGE of a 1920x1080 cart. If the window
  -- is smaller and the present path clamps or renders to a corner, this
  -- marker is what goes missing.
  g.setColor(1, 0.85, 0.2)
  g.rectangle("fill", W - 120, H - 120, 100, 100)
  g.rectangle("fill", 20, H - 120, 100, 100)
  g.rectangle("fill", W - 120, 20, 100, 100)
  stages = stages | 32

  g.setScissor()
  ok = (stages == 63) and 1 or 0
  wc.debug_set(0, ok)
  wc.debug_set(1, stages)
end
