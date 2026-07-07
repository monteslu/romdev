pico-8 cartridge // http://www.pico-8.com
version 18
__lua__
-- color drop — a falling-block puzzle scaffold
-- genre example for romdev/pico8. real faceted gem sprites (see __gfx__),
-- looping music, match-3 line clears with a flash + gravity settle,
-- soft/hard drop, score + combo, next-gem preview. fork it.

cols=8 rows=12 cell=10 ox=22 oy=6

function _init()
 hi=0
 state="title"
 reset_game()
 music(0)
end

function reset_game()
 grid={}
 for y=1,rows do grid[y]={} for x=1,cols do grid[y][x]=0 end end
 score=0 combo=0 fall=0 t=0 flash={}
 nxt=flr(rnd(5))+1
 spawn_piece()
end

function spawn_piece()
 piece={x=flr(cols/2),y=1,c=nxt}
 nxt=flr(rnd(5))+1
 if grid[1][piece.x]~=0 then state="over" hi=max(hi,score) music(-1) end
end

function _update()
 t+=1
 if #flash>0 then
  flash[1].ttl-=1
  if flash[1].ttl<=0 then apply_clear(flash[1]) del(flash,flash[1]) end
  return
 end
 if state=="title" then
  if btnp(4) or btnp(5) then state="play" reset_game() music(1) end
  return
 end
 if state=="over" then
  if btnp(4) or btnp(5) then state="title" music(0) end
  return
 end

 if btnp(0) and piece.x>1 and grid[piece.y][piece.x-1]==0 then piece.x-=1 sfx(2) end
 if btnp(1) and piece.x<cols and grid[piece.y][piece.x+1]==0 then piece.x+=1 sfx(2) end

 local speed=(btn(3) or btn(4)) and 2 or 22
 fall+=1
 if fall>=speed then
  fall=0
  local ny=piece.y+1
  if ny>rows or grid[ny][piece.x]~=0 then
   grid[piece.y][piece.x]=piece.c sfx(0)
   scan_matches() spawn_piece()
  else piece.y=ny end
 end
end

function scan_matches()
 local hits={}
 for y=1,rows do
  local run=1
  for x=2,cols+1 do
   if x<=cols and grid[y][x]~=0 and grid[y][x]==grid[y][x-1] then run+=1
   else
    if run>=3 then for k=x-run,x-1 do add(hits,{x=k,y=y}) end end
    run=1
   end
  end
 end
 if #hits>0 then add(flash,{cells=hits,ttl=10}) sfx(1) end
end

function apply_clear(fl)
 combo+=1
 score+=#fl.cells*10*combo
 for c in all(fl.cells) do grid[c.y][c.x]=0 end
 -- gravity settle
 for x=1,cols do
  local w=rows
  for y=rows,1,-1 do
   if grid[y][x]~=0 then grid[w][x]=grid[y][x] if w~=y then grid[y][x]=0 end w-=1 end
  end
 end
 scan_matches()
 if #flash==0 then combo=0 end
end

function drawgem(gx,gy,c,big)
 spr(c,gx,gy)
end

function _draw()
 cls(1)
 rectfill(0,0,127,127,0)
 -- subtle backdrop grid glow
 for i=0,127,16 do line(i,0,i,127,1) line(0,i,127,i,1) end

 if state=="title" then
  print("color drop",42,44,12)
  for i=1,5 do spr(i,30+i*12,60) end
  print("arrows slide",34,82,7)
  print("down  drop",38,92,6)
  print("z/x  start",40,102,7)
  return
 end

 rect(ox-1,oy-1,ox+cols*cell,oy+rows*cell,5)
 for y=1,rows do for x=1,cols do
  if grid[y][x]~=0 then drawgem(ox+(x-1)*cell,oy+(y-1)*cell,grid[y][x]) end
 end end
 -- flash clears
 for fl in all(flash) do
  for c in all(fl.cells) do
   if t%4<2 then rectfill(ox+(c.x-1)*cell,oy+(c.y-1)*cell,ox+(c.x-1)*cell+8,oy+(c.y-1)*cell+8,7) end
  end
 end
 if state=="play" and #flash==0 then
  drawgem(ox+(piece.x-1)*cell,oy+(piece.y-1)*cell,piece.c)
 end

 -- side panel
 print("score",104,8,7) print(score,104,16,10)
 print("next",104,40,7) spr(nxt,106,48)
 if combo>1 then print("x"..combo,104,66,8) end

 if state=="over" then
  rectfill(18,52,110,76,0) rect(18,52,110,76,8)
  print("game over",44,56,8)
  print("hi "..hi,52,66,10)
 end
end

__gfx__
0000000000888000009990000aaa9000000bb00000eee0000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0000000008888800099999900aaaa9000bbbbb000eeeee0000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0000000088828880999a9990aaa9a9a0bbb3bbb0eee7eee000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0000000088888880999999909aaaa9a0bbbbbbb0eeeeeee000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0000000088888880999999900aaaa9a0bbbbbbb0eeeeeee000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0000000008888800099999000aaaa9000bbbbb000eeeee0000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0000000000888000009990000aaa9000000bb00000eee0000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
__sfx__
010800001c0551c0550000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
011000002465527655296552d655000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
010400001865518655000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
__music__
00 40424344
00 41424344
