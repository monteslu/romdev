pico-8 cartridge // http://www.pico-8.com
version 18
__lua__
-- hop quest — a platformer scaffold
-- genre example for romdev/pico8. real hero sprite w/ walk + jump frames
-- (see __gfx__), looping music, sfx, gravity + solid-box collision,
-- animated spinning coins, a goal flag, parallax hills. fork it.

-- sprites: 1 idle,2 walk,3 jump · 5..8 coin spin frames · 10 flag

function _init()
 best=99
 state="title"
 boot=0
 build_level()
 reset_player()
 music(0)
end

function build_level()
 solids={
  {0,120,128,8},{24,100,24,6},{60,84,30,6},
  {98,64,24,6},{6,58,18,6},{40,42,28,6},
 }
 coins={}
 for c in all({{34,90},{72,74},{108,54},{14,48},{50,32}}) do
  add(coins,{x=c[1],y=c[2],f=rnd(4)})
 end
 goal={x=52,y=24}
end

function reset_player()
 p={x=6,y=104,dx=0,dy=0,grounded=false,face=1,anim=0}
 collected=0 total=#coins t=0
end

function solid_at(x,y)
 for s in all(solids) do
  if x>=s[1] and x<s[1]+s[3] and y>=s[2] and y<s[2]+s[4] then return true end
 end
 return false
end

-- the top Y of a platform the feet CROSS this step: feet were at/above the top (oldy)
-- and reach at/below it (newy). returns the highest such top, or nil. this catch-the-
-- crossing test is what stops fast falls from tunneling straight through a platform.
function ground_top(x,oldy,newy)
 local best=nil
 for s in all(solids) do
  local top=s[2]
  if x>=s[1] and x<s[1]+s[3] and oldy<=top+1 and newy>=top then
   if best==nil or top<best then best=top end
  end
 end
 return best
end

function _update()
 t+=1
 for c in all(coins) do c.f+=.2 end
 if state=="title" then
  boot+=1
  if boot>10 and (btnp(4) or btnp(5)) then state="play" build_level() reset_player() music(-1) end
  return
 end
 if state=="win" then
  if btnp(4) or btnp(5) then state="title" end
  return
 end

 local ax=0
 if btn(0) then ax=-1 p.face=-1 end
 if btn(1) then ax=1 p.face=1 end
 p.dx=ax*1.6
 if ax~=0 then p.anim+=.25 else p.anim=0 end

 if (btn(4) or btn(2)) and p.grounded then p.dy=-4.2 p.grounded=false sfx(0) end
 p.dy=min(p.dy+.3,4)

 -- horizontal move (block at body height)
 local nx=p.x+p.dx
 if not solid_at(nx+(p.dx>0 and 3 or -3),p.y-3) then p.x=nx end

 -- vertical move. p.y = the FEET. land exactly on a platform's top edge.
 local ny=p.y+p.dy
 if p.dy>=0 then
  -- falling: if the feet CROSS a platform top this step, snap onto it (no tunneling).
  local gt=ground_top(p.x,p.y,ny)
  if gt~=nil then
   p.y=gt p.dy=0 p.grounded=true
  else
   p.y=ny p.grounded=false
  end
 else
  -- rising: bonk head on a ceiling
  if solid_at(p.x,ny-7) then p.dy=0 else p.y=ny end
  p.grounded=false
 end
 p.x=mid(4,p.x,124)
 if p.y>140 then reset_player() sfx(3) end

 for c in all(coins) do
  if abs(c.x-p.x)<6 and abs(c.y-p.y)<7 then del(coins,c) collected+=1 sfx(1) end
 end
 if abs(goal.x-p.x)<7 and abs(goal.y-p.y)<9 then
  best=min(best,t\30) state="win" sfx(2) music(-1)
 end
end

function _draw()
 cls(12)
 -- parallax hills
 for i=0,4 do circfill(i*34-8,126,22,3) end
 for i=0,3 do circfill(i*44+20,128,26,11) end

 if state=="title" then
  print("hop quest",44,44,7)
  spr(1,60,60)
  print("z/up  jump",40,80,6)
  print("z/x  start",40,92,7)
  return
 end

 for s in all(solids) do
  rectfill(s[1],s[2],s[1]+s[3]-1,s[2]+s[4]-1,4)
  rectfill(s[1],s[2],s[1]+s[3]-1,s[2],9)  -- grass top
 end
 for c in all(coins) do spr(5+flr(c.f)%4,c.x-4,c.y-4) end
 -- flag
 rectfill(goal.x,goal.y,goal.x,goal.y+12,6)
 spr(10,goal.x,goal.y-1)
 -- hero
 local s=p.grounded and (p.dx~=0 and (5+flr(p.anim)%2==5 and 2 or (flr(p.anim)%2==0 and 1 or 2)) or 1) or 3
 spr(p.dx~=0 and (flr(p.anim)%2==0 and 1 or 2) or (p.grounded and 1 or 3),p.x-4,p.y-7,1,1,p.face<0)

 rectfill(0,0,127,7,0)
 print("coins "..collected.."/"..total,2,1,10)
 if best<99 then print("best "..best.."s",84,1,6) end
 if state=="win" then
  rectfill(28,50,100,80,0) rect(28,50,100,80,11)
  print("you win!",44,55,11)
  print("time "..(t\30).."s",44,64,7)
  print("z/x  title",40,72,6)
 end
end

__gfx__
0000000000fff00000fff00080fff0080000000000aaaa00000aa0000000a000000aa00000066000066000000000000000000000000000000000000000000000
0000000000fff00000fff00008fff880000000000a9779a000a99a00000a9a0000a99a0000066660066600000000000000000000000000000000000000000000
0000000000f4f00000f4f00000f4f00000000000a977779a0a9779a0000a9a000a9779a000060000066660000000000000000000000000000000000000000000
0000000008888000088880000088880000000000a977779a0a9779a0000a9a000a9779a000060000066600000000000000000000000000000000000000000000
0000000008888000088880000088880000000000a999999a0a9999a0000a9a000a9999a000600000066000000000000000000000000000000000000000000000
0000000008880000088800000008800000000000a999999a0a9999a0000a9a000a9999a000060000060000000000000000000000000000000000000000000000
00000000008008000088000000800800000000000a9999a000a99a00000a9a0000a99a0000060000060000000000000000000000000000000000000000000000
0000000000b00b00000bb00000b00b000000000000aaaa00000aa0000000a000000aa00000060000060000000000000000000000000000000000000000000000
__sfx__
000300001f04025040290400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000200002465527655296550000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
011000002465521655216551d6551a655000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
010600000865505655036550000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
001400001c4501c4501d4501f4501f4501d4501c4501a45018450184501a4501c4501c4501a4501a4501a4501c4501c4501d4501f4501f4501d4501c4501a45018450184501a4501c4501a450184501845018450
001400000c2300c2300c2301323013230132300c230132300c2300c230132300c2300c2301323013230132300c2300c2300c2301323013230132300c230132300c2300c230132300c230132300c2300c2300c230
__music__
03 08094040
