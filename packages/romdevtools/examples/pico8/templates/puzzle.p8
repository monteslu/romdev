pico-8 cartridge // http://www.pico-8.com
version 18
__lua__
-- color drop — a falling-column match puzzle (Columns-style) scaffold
-- genre example for romdev/pico8. THE GAME: a vertical column of 3 jewels
-- falls into an 8-wide well. move left/right, soft-drop (down), hard-drop
-- (x), and CYCLE the 3 colors (o). match 3+ of one color horizontally,
-- vertically, or DIAGONALLY to clear; gravity pulls survivors down, which
-- can CASCADE into more clears. fork it and reshape one thing at a time.

cols=8 rows=13 cell=9 ox=26 oy=3
ncol=5  -- jewel colors 1..5
-- well fits the 128px screen: oy + rows*cell = 3 + 117 = 120 (bottom row fully visible).

function _init()
 hi=0
 state="title"
 boot=0
 reset_game()

 music(0)
end

function reset_game()
 grid={}
 for y=1,rows do grid[y]={} for x=1,cols do grid[y][x]=0 end end
 score=0 chain=0 level=1 cleared=0
 fall=0 t=0
 flashing=nil  -- {cells=..,ttl=..} during a clear
 nextp=randcol3()
 spawn_piece()
end

function randcol3()
 return {flr(rnd(ncol))+1,flr(rnd(ncol))+1,flr(rnd(ncol))+1}
end

-- the falling column: 3 colors top->bottom at (px, py=top cell)
function spawn_piece()
 pcol=nextp
 nextp=randcol3()
 px=flr(cols/2) py=1
 -- game over if the top cells are blocked
 if grid[1][px]~=0 or grid[2][px]~=0 or grid[3][px]~=0 then
  hi=max(hi,score) state="over"
 end
end

function can_be(x,y)
 -- can the 3-tall column sit with its TOP cell at (x,y)?
 for i=0,2 do
  local cy=y+i
  if cy>rows then return false end
  if cy>=1 and grid[cy][x]~=0 then return false end
 end
 return true
end

function _update()
 t+=1

 -- resolve an in-progress clear (flash then remove + cascade)
 if flashing then
  flashing.ttl-=1
  if flashing.ttl<=0 then
   for c in all(flashing.cells) do grid[c.y][c.x]=0 end
   collapse()
   local m=find_matches()
   if #m>0 then chain+=1 start_clear(m)
   else chain=0 flashing=nil spawn_piece() end
  end
  return
 end

 if state=="title" then
  boot+=1
  if boot>10 and (btnp(4) or btnp(5)) then state="play" reset_game() music(-1) end
  return
 end
 if state=="over" then
  if btnp(4) or btnp(5) then state="title" end
  return
 end

 -- move — snappy custom repeat (move on press, then again every 4 frames while held)
 -- so a hold slides smoothly instead of pico-8's slow 15-frame btnp repeat.
 hold_l = btn(0) and (hold_l or 0)+1 or 0
 hold_r = btn(1) and (hold_r or 0)+1 or 0
 if (hold_l==1 or (hold_l>4 and hold_l%3==0)) and px>1 and can_be(px-1,py) then px-=1 sfx(2) end
 if (hold_r==1 or (hold_r>4 and hold_r%3==0)) and px<cols and can_be(px+1,py) then px+=1 sfx(2) end
 -- cycle colors (o = btn4): rotate the 3-jewel column
 if btnp(4) then
  pcol={pcol[3],pcol[1],pcol[2]} sfx(3)
 end
 -- hard drop (x = btn5)
 if btnp(5) then
  while can_be(px,py+1) do py+=1 end
  lock_piece() return
 end

 -- gravity (soft-drop on down)
 local speed=btn(3) and 2 or max(6,26-level*2)
 fall+=1
 if fall>=speed then
  fall=0
  if can_be(px,py+1) then py+=1
  else lock_piece() end
 end
end

function lock_piece()
 for i=0,2 do
  local cy=py+i
  if cy>=1 and cy<=rows then grid[cy][px]=pcol[i+1] end
 end
 sfx(0)
 local m=find_matches()
 if #m>0 then chain=1 start_clear(m)
 else spawn_piece() end
end

function start_clear(cells)
 flashing={cells=cells,ttl=12}
 score+=#cells*10*chain
 cleared+=#cells
 level=1+flr(cleared/20)
 sfx(1)
end

-- scan H, V, and both diagonals for runs of 3+ same color.
-- returns a list of {x,y} cells to clear (deduped).
local dirs={{1,0},{0,1},{1,1},{1,-1}}
function find_matches()
 local hit={}  -- key "x,y" -> {x,y}
 for y=1,rows do for x=1,cols do
  local c=grid[y][x]
  if c~=0 then
   for d in all(dirs) do
    -- only start a run at its beginning (no same-color cell behind us)
    local bx,by=x-d[1],y-d[2]
    local prev = (bx>=1 and bx<=cols and by>=1 and by<=rows) and grid[by][bx] or -1
    if prev~=c then
     local run={}
     local cx,cy=x,y
     while cx>=1 and cx<=cols and cy>=1 and cy<=rows and grid[cy][cx]==c do
      add(run,{x=cx,y=cy}) cx+=d[1] cy+=d[2]
     end
     if #run>=3 then for r in all(run) do hit[r.x..","..r.y]={x=r.x,y=r.y} end end
    end
   end
  end
 end end
 local out={} for _,v in pairs(hit) do add(out,v) end
 return out
end

-- gravity: drop every column's survivors to the bottom
function collapse()
 for x=1,cols do
  local w=rows
  for y=rows,1,-1 do
   if grid[y][x]~=0 then
    grid[w][x]=grid[y][x] if w~=y then grid[y][x]=0 end w-=1
   end
  end
 end
end

-- ── draw ──
gemcol={8,9,10,11,12}
function drawgem(gx,gy,c)
 local base=gemcol[c] or 8
 rectfill(gx+1,gy,gx+6,gy+7,base)
 rectfill(gx,gy+1,gx+7,gy+6,base)
 rectfill(gx+2,gy+1,gx+3,gy+2,7)   -- sparkle
 line(gx+1,gy+6,gx+6,gy+6,1)       -- shadow
end

function _draw()
 cls(0)
 rectfill(0,0,ox-2,127,1)
 rectfill(ox+cols*cell+1,0,127,127,1)

 if state=="title" then
  print("color drop",42,40,12)
  -- show a sample 3-jewel column
  for i=1,3 do drawgem(60,50+i*9,i) end
  print("arrows move",34,86,7)
  print("o cycle  x drop",26,96,6)
  print("z/x  start",40,108,7)
  return
 end

 rect(ox-1,oy-1,ox+cols*cell,oy+rows*cell,5)
 -- placed gems
 for y=1,rows do for x=1,cols do
  if grid[y][x]~=0 then drawgem(ox+(x-1)*cell,oy+(y-1)*cell,grid[y][x]) end
 end end
 -- flashing clears
 if flashing then
  for c in all(flashing.cells) do
   if t%4<2 then rectfill(ox+(c.x-1)*cell,oy+(c.y-1)*cell,ox+(c.x-1)*cell+8,oy+(c.y-1)*cell+8,7) end
  end
 elseif state=="play" then
  -- the falling 3-jewel column
  for i=0,2 do
   local cy=py+i
   if cy>=1 then drawgem(ox+(px-1)*cell,oy+(cy-1)*cell,pcol[i+1]) end
  end
 end

 -- panel
 print("score",102,8,7) print(score,102,16,10)
 print("next",102,36,7)
 for i=1,3 do drawgem(106,44+i*9,nextp[i]) end
 print("lv "..level,102,76,7)
 if chain>1 then print("x"..chain,102,88,8) end

 if state=="over" then
  rectfill(18,52,110,76,0) rect(18,52,110,76,8)
  print("game over",44,56,8)
  print("hi "..hi,52,66,10)
 end
end

__gfx__
00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
__sfx__
010800001c0551c055000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
011000002465527655296552d65500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
010400001865518655000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
010c00002465521655000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0014000028450274502845027450284502345026450244502145000000184501c4502145023450000001c450204502345024450000001c4502845027450284502745028450234502645024450214500000000000
001400001523000000000000000015230000000000000000102300000000000000000c23000000000000000015230000000000000000152300000000000000001023000000000000000015230000000000000000
__music__
03 08094040
