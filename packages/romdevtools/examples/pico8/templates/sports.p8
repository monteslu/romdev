pico-8 cartridge // http://www.pico-8.com
version 18
__lua__
-- rally volley — a 2-player paddle sports scaffold
-- genre example for romdev/pico8. paddle + ball sprites (see __gfx__),
-- looping music, bounce sfx, angle-off-paddle physics, speed-up on rally,
-- 1p-vs-cpu or 2p couch mode, first to 5. fork it.

function _init()
 state="title"
 ai=true
 reset_match()
 music(0)
end

function reset_match()
 lp={y=64,score=0} rp={y=64,score=0}
 rally=0
 serve(pick_dir())
end

function pick_dir() return (rnd(1)<.5) and -1 or 1 end

function serve(dir)
 ball={x=64,y=64,dx=dir*1.4,dy=(rnd(2)-1)*1.1}
 wait=36
end

function _update()
 if state=="title" then
  if btnp(2) or btnp(3) then ai=not ai sfx(3) end
  if btnp(4) or btnp(5) then state="play" reset_match() music(1) end
  return
 end
 if state=="over" then
  if btnp(4) or btnp(5) then state="title" music(0) end
  return
 end

 if btn(2) then lp.y-=2 end
 if btn(3) then lp.y+=2 end
 lp.y=mid(12,lp.y,116)

 if ai then
  if ball.dx>0 then rp.y+=mid(-2,(ball.y-rp.y)*.11,2) end
 else
  if btn(4) then rp.y-=2 end
  if btn(5) then rp.y+=2 end
 end
 rp.y=mid(12,rp.y,116)

 if wait>0 then wait-=1 return end

 ball.x+=ball.dx ball.y+=ball.dy
 if ball.y<4 or ball.y>123 then ball.dy=-ball.dy sfx(0) end

 if ball.dx<0 and ball.x<9 and abs(ball.y-lp.y)<11 then
  ball.dx=abs(ball.dx)+.12 ball.dy+=(ball.y-lp.y)*.07 rally+=1 sfx(1)
 end
 if ball.dx>0 and ball.x>119 and abs(ball.y-rp.y)<11 then
  ball.dx=-abs(ball.dx)-.12 ball.dy+=(ball.y-rp.y)*.07 rally+=1 sfx(1)
 end
 ball.dy=mid(-3,ball.dy,3)

 if ball.x<0 then rp.score+=1 point() end
 if ball.x>128 then lp.score+=1 point() end
end

function point()
 sfx(2) rally=0
 if lp.score>=5 or rp.score>=5 then
  winner=lp.score>rp.score and "left" or "right"
  state="over" music(-1)
 else
  serve(pick_dir())
 end
end

function _draw()
 cls(0)
 rectfill(0,0,127,127,1)
 rectfill(0,0,127,127,0)
 for y=2,124,8 do rectfill(63,y,64,y+4,5) end

 if state=="title" then
  print("rally volley",38,40,12)
  spr(2,20,58) spr(1,64,58) spr(3,100,58)
  print("mode: "..(ai and "1p vs cpu" or "2 player"),34,80,7)
  print("up/down  toggle",30,90,6)
  print("z/x  start",40,102,7)
  return
 end

 spr(2,2,lp.y-4)
 spr(3,120,rp.y-4)
 spr(1,ball.x-2,ball.y-2)

 rectfill(0,0,127,8,0)
 print(lp.score,40,2,12)
 print(rp.score,84,2,8)
 if rally>2 then print("rally "..rally,50,2,10) end

 if state=="over" then
  rectfill(24,52,104,78,0) rect(24,52,104,78,11)
  print(winner.." wins!",38,58,11)
  print(lp.score.." - "..rp.score,52,68,7)
 end
end

__gfx__
0000000000cccc0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000cccccc0000cc00000cc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000c7777c000cccc00cccc0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000c7777c000cccc00cccc0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000c7777c000cccc00cccc0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000cccccc000cccc00cccc0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0000000000cccc00000cc00000cc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
__sfx__
010800001505015050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
010400001f0552405500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
011000000c05508055050550000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
010400001c0551c055000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
__music__
00 40424344
00 41424344
