import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { LibretroHost } from '../../romdev-core-host/index.js';
import { getCPUState } from '../../romdev-core-host/cpu-state.js';
import { gbFixture } from './fixtures/multiplayer/gb-fixture.mjs';
import { tool } from '../scripts/multiplayer/tool.mjs';

const packages=new URL('../../',import.meta.url),sha=b=>createHash('sha256').update(b).digest('hex');
async function nesRom(){
 const source=readFileSync(new URL('./fixtures/multiplayer/four-score.s',import.meta.url),'utf8').replace(' ldx #0\n ldy #0\n@draw:',` lda #$5a
 sta $030d
 inc $0400
 bne @published
 inc $0401
 bne @published
 inc $0402
 bne @published
 inc $0403
@published:
 lda #$a5
 sta $0404
 sta $030d
 ldx #0
 ldy #0
@draw:`);
 const a=await tool('ca65',['-g','-o','/work/world.o','/work/world.s'],{'/work/world.s':source});assert.equal(a.code,0,a.log);
 const cfg=readFileSync(new URL('./fixtures/multiplayer/four-score.cfg',import.meta.url));
 const l=await tool('ld65',['-C','/work/world.cfg','-o','/work/world.nes','/work/world.o'],{'/work/world.o':a.outputs['world.o'],'/work/world.cfg':cfg});assert.equal(l.code,0,l.log);return l.outputs['world.nes'];
}
const cartridges={gb:gbFixture(false,false,false,true),gbc:gbFixture(true,false,false,true),nes:await nesRom()};
async function host(platform){
 const core=platform==='nes'?'fceumm':'gambatte',dir=new URL(`romdev-core-${core}/wasm/`,packages),h=new LibretroHost();
 await h.loadCore({factory:(await import(new URL(`${core}_libretro.js`,dir))).default,wasmBinary:readFileSync(new URL(`${core}_libretro.wasm`,dir)),io:false});
 await h.loadMedia({platform,bytes:cartridges[platform],deterministic:{rtcEpochSeconds:0},...(platform==='nes'?{controllerTopology:{kind:'nes',playerMask:15}}:{})});return h;
}
const layout=p=>({trigger:p==='nes'?0x404:0xc024,tick:{region:'system_ram',offset:p==='nes'?0x400:0x20,length:4},fields:[{region:'system_ram',offset:p==='nes'?0x308:1,length:p==='nes'?4:1},{region:'system_ram',offset:p==='nes'?0x30d:6,length:1}]});
function frame(h,p,input){h.state.audioRing.length=0;h.setInput(input);h.stepFrames(1);return{blob:sha(h.serializeState()),digest:sha(h.stateDigest().bytes),regs:getCPUState(h,p),pixels:sha(h.screenshotRgba().rgba),audio:sha(Buffer.concat(h.state.audioRing.map(v=>Buffer.from(v.buffer,v.byteOffset,v.byteLength))))};}
for(const p of ['gb','gbc','nes'])test(`${p}: pre-view observation is nonintrusive, exact, owned and cleared at lifecycle boundaries`,async t=>{
 const observed=await host(p),baseline=await host(p);t.after(()=>observed.dispose());t.after(()=>baseline.dispose());
 observed.startWorldObservation(layout(p));let last=null,hits=0,saved=null;
 for(let f=0;f<130;f++){
  const input={ports:[{right:f%2===0,a:f%3===0},{left:f%2===0},{right:true},{left:true}]};
  assert.deepEqual(frame(observed,p,input),frame(baseline,p,input),`instrumentation changed causal execution at ${f}`);
  const got=observed.drainWorldObservation();assert.equal(got.truncated,false);
  for(const e of got.events){if(last!==null)assert.equal(e.tick,last+1);last=e.tick;hits++;assert.equal(e.bytes.at(-1),0x5a);assert.ok(e.pc>0);saved??=e.bytes.slice();}
 }
 assert.ok(hits>100);assert.equal(observed.readMemory('system_ram',p==='nes'?0x30d:6,1)[0],0xa5,'native boundary is AFTER the view write');assert.equal(saved.at(-1),0x5a,'observation owns its bytes');
 const before=observed.stateDigest(),snap=observed.serializeState();observed.unserializeState(snap);assert.throws(()=>observed.drainWorldObservation(),/no world/);assert.deepEqual(observed.stateDigest(),before);
 observed.startWorldObservation(layout(p));observed.stepFrames(12);const overflow=observed.drainWorldObservation();assert.equal(overflow.events.length,8);assert.ok(overflow.total>8);assert.equal(overflow.truncated,true);assert.equal(observed.drainWorldObservation().total,0);
 observed.reset();assert.throws(()=>observed.drainWorldObservation(),/no world/);
 observed.startWorldObservation(layout(p));observed.unloadMedia();assert.throws(()=>observed.drainWorldObservation(),/no world/);
});
test('host rejects invalid, bank-dependent and oversized world observation spans before arming',async t=>{
 const h=await host('gbc');t.after(()=>h.dispose());const c=layout('gbc');
 for(const bad of [{...c,trigger:0xd000},{...c,tick:{...c.tick,offset:0x1000}},{...c,fields:[]},{...c,fields:[{region:'video_ram',offset:0,length:1}]},{...c,fields:[{region:'system_ram',offset:0x8000,length:1}]},{...c,fields:[{region:'system_ram',offset:0,length:1024},{region:'system_ram',offset:1024,length:1}]}])assert.throws(()=>h.startWorldObservation(bad));
 assert.throws(()=>h.drainWorldObservation(),/no world/);h.startWorldObservation(c);h.stopWorldObservation();assert.throws(()=>h.drainWorldObservation(),/no world/);
});
test('native observation ring and ABI remain bounded without a CPU freeze or emulated write',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'world-observer-'));
 try{
  writeFileSync(path.join(dir,'check.c'),`#include <assert.h>
#include "romdev_debug.h"
int main(void) {
 unsigned char tick[4]={1,2,3,4}, first[2]={5,6}, second[1]={7}, output[64]; unsigned meta[3],i;
 romdev_observe_set(0x1234,tick,1); assert(!romdev_any_armed()); assert(!romdev_observe_arm(1));
 assert(!romdev_observe_add(first,1025)); assert(romdev_observe_add(first,2)); assert(romdev_observe_add(second,1)); assert(romdev_observe_arm(1));
 assert(!romdev_observe_add(first,1)); assert(romdev_any_armed()); assert(!romdev_on_dispatch(0x5678)); assert(!romdev_is_frozen());
 romdev_on_write(0x1235,0,1,0x5678,0); assert(romdev_observe_get(output,64,meta,0)==0);
 romdev_on_write(0x1234,0,2,0x5678,0); assert(romdev_observe_get(output,64,meta,0)==0);
 assert(!romdev_on_write(0x1234,0,1,0x5678,0)); first[0]=99;
 assert(romdev_observe_get(output,64,meta,1)==1); assert(meta[0]==1 && meta[1]==1 && meta[2]==11);
 assert(output[0]==1 && output[3]==4 && output[4]==0x78 && output[5]==0x56 && output[8]==5 && output[10]==7);
 for(i=0;i<10;i++) romdev_on_write(0x1234,0,1,0x5678,0);
 assert(romdev_observe_get(output,11,meta,0)==1); assert(meta[0]==10 && meta[1]==8);
 assert(romdev_observe_get(0,0,meta,1)==0); assert(meta[0]==10); assert(romdev_observe_get(output,64,meta,0)==0);
 romdev_observe_set(0,0,0); assert(!romdev_any_armed()); assert(!romdev_is_frozen()); return 0;
}`);
  const inc=new URL('../scripts/romdev-debug/',import.meta.url),bin=path.join(dir,'check');
  execFileSync('cc',['-std=c89','-Wall','-Wextra','-Werror','-I',inc.pathname,path.join(dir,'check.c'),new URL('romdev_debug.c',inc).pathname,'-o',bin]);execFileSync(bin,[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
