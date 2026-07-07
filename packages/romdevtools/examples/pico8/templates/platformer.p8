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

function _update()
 t+=1
 for c in all(coins) do c.f+=.2 end
 if state=="title" then
  if btnp(4) or btnp(5) then state="play" build_level() reset_player() music(1) end
  return
 end
 if state=="win" then
  if btnp(4) or btnp(5) then state="title" music(0) end
  return
 end

 local ax=0
 if btn(0) then ax=-1 p.face=-1 end
 if btn(1) then ax=1 p.face=1 end
 p.dx=ax*1.6
 if ax~=0 then p.anim+=.25 else p.anim=0 end

 if (btn(4) or btn(2)) and p.grounded then p.dy=-4.2 p.grounded=false sfx(0) end
 p.dy=min(p.dy+.3,4)

 local nx=p.x+p.dx
 if not solid_at(nx+(p.dx>0 and 3 or -3),p.y-3) then p.x=nx end
 local ny=p.y+p.dy
 if p.dy>0 then
  if solid_at(p.x,ny) or solid_at(p.x-2,ny) or solid_at(p.x+2,ny) then
   p.dy=0 p.grounded=true p.y=flr(ny/2)*2
  else p.y=ny p.grounded=false end
 else
  if not solid_at(p.x,ny-7) then p.y=ny else p.dy=0 end
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
000000000009900000099000000990000000000000eee00000eee00000eee00000eee000000660000000000000000000000000000000000000000000000000000
0000000000099000000990000009900000000000000e0000000e0000000e0000000e0000000666600000000000000000000000000000000000000000000000000
0000000000099000000990000ee9900000000000000e0000000e0000000e0000000e0000000600000000000000000000000000000000000000000000000000000
00000000009999000099990000999900000000000eeeee000eeeee000eeeee000eeeee00000600000000000000000000000000000000000000000000000000000
0000000000c99c0000c99c000c9999000000000000e7e7000e7e7000e7e7000e7e7e00000060000000000000000000000000000000000000000000000000000000
0000000000c00c00000cc000c000000c0000000000eeeee000eeeee000eeeee000eeeee00006000000000000000000000000000000000000000000000000000000
0000000000900900009009000090090000000000000e0e00000e0e00000e0e00000e0e0000060000000000000000000000000000000000000000000000000000000
00000000090009000900090009000900000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000
__sfx__
010800002105524055000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
010400001c6551f655236552765500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
011000002465521655216551d6551a655000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
010600000865505655036550000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
__music__
00 41424344
00 42434445
