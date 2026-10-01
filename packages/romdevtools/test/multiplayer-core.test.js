import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {LibretroHost} from '../../romdev-core-host/index.js';
import {getCPUState} from '../../romdev-core-host/cpu-state.js';
import {fourScoreRom, tool} from '../scripts/multiplayer/tool.mjs';
import {gbFixture} from './fixtures/multiplayer/gb-fixture.mjs';
const root = new URL('../../', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtures = {nes:(await fourScoreRom()).outputs['pads.nes'], gb:gbFixture(false), gbc:gbFixture(true)};
async function host(platform, mask=15, deterministic=true, coreOptions=undefined, rom=fixtures[platform]) {
 const core = platform==='nes'?'fceumm':'gambatte';
 const url = new URL(`romdev-core-${core}/wasm/${core}_libretro.js`,root);
 const h = new LibretroHost();
 await h.loadCore({factory:(await import(url)).default,wasmBinary:readFileSync(new URL(`romdev-core-${core}/wasm/${core}_libretro.wasm`,root)),io:false});
 await h.loadMedia({platform,bytes:rom,coreOptions,...(deterministic?{deterministic:{rtcEpochSeconds:0}}:{}),...(platform==='nes'?{controllerTopology:{kind:'nes',playerMask:mask}}:{})});
 return h;
}
const digest = h => Buffer.from(h.stateDigest().bytes).toString('hex');
function frame(h,input) {
 h.setInput(input);h.state.audioRing.length=0;h.stepFrames(1);
 return {hasAudio:h.state.audioRing.some(chunk=>chunk.some(value=>value!==0)),digest:digest(h),pixels:sha(h.screenshotRgba().rgba),audio:sha(Buffer.concat(h.state.audioRing.map(v=>Buffer.from(v.buffer,v.byteOffset,v.byteLength)))),regs:getCPUState(h,h.status.platform),ram:sha(h.readMemory('system_ram',0,h.status.platform==='nes'?2048:h.status.platform==='gbc'?32768:8192))};
}
for(const platform of ['gb','gbc','nes'])test(`${platform}: staggered boot and complete rollback future`,async t=>{
 const a=await host(platform);t.after(()=>a.dispose());
 // Cross a wall-clock second. No state is exchanged between booted instances.
 await new Promise(resolve=>setTimeout(resolve,1100));
 const b=await host(platform);t.after(()=>b.dispose());
 a.stepFrames(130);b.stepFrames(130);assert.equal(digest(a),digest(b));
 assert.equal(digest(a),sha(a.serializeState())); // Core SHA-256 known reference.
 const pixels=a.screenshotRgba().rgba;assert.ok(pixels.some((v,i)=>i%4!==3 && v!==pixels[i%4]),"Fixture renders visible content");
 const inputs=Array.from({length:32},(_,f)=>({ports:Array.from({length:platform==='nes'?4:1},(_,p)=>({right:(f+p)%12<6,a:(f+p)%8<4,b:f%7<3}))}));
 const snapshot=a.serializeState();const expected=inputs.map(i=>frame(a,i));
 a.unserializeState(snapshot);assert.equal(digest(a),sha(snapshot));
 for(let i=0;i<inputs.length;i++)assert.deepEqual(frame(a,inputs[i]),expected[i],`corrected frame ${i}`);
 assert.equal(a.mod._romdev_state_digest(0,32),0);
 const before=digest(a),ram=a.readMemory('system_ram',0,1);a.writeMemory('system_ram',0,new Uint8Array([ram[0]^1]));assert.notEqual(digest(a),before);
 assert.throws(()=>a.setInput({ports:[{l:true}]}),/native digital/);
 if(platform==='gbc') {
  assert.equal(a.readMemory('system_ram',0x400,1)[0],0xa5);
  assert.equal(a.readMemory('system_ram',0x10f0,1)[0],0x5a);
  assert.equal(a.readMemory('system_ram',0x20f0,1)[0],0x99);
 }
});
test('NES native Four Score: 1–4 players, stable slots, release, reload',async t=>{
 const h=await host('nes');t.after(()=>h.dispose());
 const load=async mask=>{await h.loadMedia({platform:'nes',bytes:fixtures.nes,deterministic:{rtcEpochSeconds:0},controllerTopology:{kind:'nes',playerMask:mask}});h.stepFrames(12);};
 for(const mask of [1,3,7,15,5,9]) {
  await load(mask);h.setInput({ports:[{a:true},{b:true},{select:true},{start:true}]});h.stepFrames(4);
  const pads=h.readMemory('system_ram',0x300,6);
  assert.deepEqual(Array.from(pads.slice(0,2)),[mask&1?1:0,mask&2?2:0]);
  assert.deepEqual(Array.from(pads.slice(2,4)),mask>3?[mask&4?4:0,mask&8?8:0]:[255,255]);
  assert.deepEqual(Array.from(pads.slice(4)),mask>3?[8,4]:[255,255]);
  const snap=h.serializeState();h.setInput({ports:[{right:true},{left:true},{right:true},{left:true}]});h.stepFrames(4);h.unserializeState(snap);assert.equal(digest(h),sha(snap));
  h.setInput({ports:[]});h.stepFrames(4);assert.deepEqual(Array.from(h.readMemory('system_ram',0x300,2)),[0,0]);
 }
 await h.loadMedia({platform:'nes',bytes:fixtures.nes});h.stepFrames(4);
 assert.deepEqual(Array.from(h.readMemory('system_ram',0x302,4)),[255,255,255,255]);
 assert.throws(()=>h.stateDigest(),/rejected/);
});
test('SDCC existing debug records retain pinned absolute object sizes in c1mode',async()=>{
 const source='#line 1 "probe.c"\n__at (0xD0EF) unsigned short edge;\n__at (0xD0EE) unsigned char crossing[4];\nstatic __at (0xD0F0) unsigned char unused[7];\nvoid main(void){edge=1;crossing[3]=2;}\n';
 const r=await tool('sdcc',['-msm83','--debug','--c1mode','-o','/work/probe.asm'],{'/work/probe.c':source},source);assert.equal(r.code,0,r.log);
 const adb=new TextDecoder().decode(r.outputs['probe.adb']);const asm=new TextDecoder().decode(r.outputs['probe.asm']);
 assert.match(adb,/G\$edge.*\{2\}SI:U/);assert.match(adb,/G\$crossing.*\{4\}DA4d/);
 assert.match(adb,/unused.*\{7\}DA7d/);assert.match(asm,/_edge\s*=\s*0xd0ef/i);assert.match(asm,/_crossing\s*=\s*0xd0ee/i);assert.match(asm,/_unused\s*=\s*0xd0f0/i);
});
test('cc65 existing linker records join object addresses and allocation spans',async()=>{
 const source='#pragma bss-name(push, "STATE")\nunsigned char crossing[4];\nunsigned int edge;\n#pragma bss-name(pop)\n';
 const cc=await tool('cc65',['--debug-info','-t','nes','-o','/work/probe.s','/work/probe.c'],{'/work/probe.c':source});assert.equal(cc.code,0,cc.log);
 const asm=await tool('ca65',['-g','-t','nes','-o','/work/probe.o','/work/probe.s'],{'/work/probe.s':cc.outputs['probe.s']});assert.equal(asm.code,0,asm.log);
 const cfg='MEMORY { RAM: start=$03EE, size=$0012, type=rw; }\nSEGMENTS { STATE: load=RAM, type=bss; }\n';
 const link=await tool('ld65',['--dbgfile','/work/probe.dbg','-C','/work/probe.cfg','-o','/work/probe.bin','/work/probe.o'],{'/work/probe.o':asm.outputs['probe.o'],'/work/probe.cfg':cfg});assert.equal(link.code,0,link.log);
 const dbg=new TextDecoder().decode(link.outputs['probe.dbg']);
 assert.match(dbg,/sym\s+[^\n]*name="_crossing"[^\n]*val=0x3EE/);
 assert.match(dbg,/span\s+[^\n]*start=0,size=4/);
 assert.match(dbg,/sym\s+[^\n]*name="_edge"[^\n]*val=0x3F2/);
 assert.match(dbg,/span\s+[^\n]*start=4,size=2/);
});

test('NES audio histories restore at all supported filter qualities',async t=>{
 for(const quality of ['Low','High','Very High']){
  const h=await host('nes',15,true,{fceumm_sndquality:quality});t.after(()=>h.dispose());
  h.setInput({ports:[{a:true}]});h.stepFrames(30);const snapshot=h.serializeState();
  const inputs=Array.from({length:32},(_,i)=>({ports:[{a:i%8<4,right:i%6<3}]}));
  const expected=inputs.map(i=>frame(h,i));assert.ok(expected.some(f=>f.hasAudio),quality);
  h.unserializeState(snapshot);for(let i=0;i<inputs.length;i++)assert.deepEqual(frame(h,inputs[i]),expected[i],quality+' frame '+i);
  h.dispose();
 }
});
test('invalid bootstrap is rejected before changing live session state',async t=>{
 const h=await host('nes');t.after(()=>h.dispose());h.setInput({ports:[{right:true}]});h.stepFrames(4);const before=digest(h);
 for(const deterministic of [{rtcEpochSeconds:-1},{rtcEpochSeconds:0.5},{}])await assert.rejects(h.loadMedia({platform:'nes',bytes:fixtures.nes,deterministic}),/31-bit RTC/);
 assert.equal(digest(h),before);assert.equal(h.state.inputPorts[0][0],128);
});

test('deterministic load leaves the CPU at reset before hidden warm-up',async t=>{
 for(const platform of ['gb','gbc','nes']){
  const h=await host(platform);t.after(()=>h.dispose());
  assert.equal(getCPUState(h,platform).pc,platform==='nes'?0:0x100);
  assert.equal(h.status.frameCount,0);h.dispose();
 }
});

for (const platform of ['gb', 'gbc']) test(`${platform}: LCD-off bootstrap restores before world initialization`, async t => {
 const h = await host(platform, 15, true, undefined, gbFixture(platform === 'gbc', false, true));
 t.after(() => h.dispose());
 h.stepFrames(12);
 assert.equal(h.readMemory('system_ram', 0x20, 1)[0], 0x5a);
 for (const wait of [0, 1, 5, 30]) {
  h.stepFrames(wait);
  assert.equal(h.readMemory('system_ram', 0x21, 1)[0], 0);
  const snapshot = h.serializeState(), before = digest(h);
  const inputs = Array.from({length: 40}, (_, f) => ({ports: [{right: f % 3 === 0, a: f % 7 < 3}]}));
  const run = () => inputs.map((input, f) => {
   if (f === 8) h.writeMemory('system_ram', 0x21, new Uint8Array([1]));
   return frame(h, input);
  });
  const expected = run();
  h.unserializeState(snapshot);
  assert.equal(digest(h), before, `LCD-off restore after ${wait} extra frames`);
  assert.deepEqual(h.serializeState(), snapshot);
  assert.deepEqual(run(), expected, 'LCD remains off, then native LCD/STAT IRQ/sprites resume');
  h.unserializeState(snapshot);
 }
});

// These parsers belong only to the pinned core's tests. Consumers use stateDigest().
for(const platform of ['gb','gbc'])test(`${platform}: active state survives an intervening LCD-off restore`,async t=>{
 const h=await host(platform,15,true,undefined,gbFixture(platform==='gbc',false,true));t.after(()=>h.dispose());
 h.stepFrames(12);const boot=h.serializeState();
 for(const count of [1,2,3,8,30]){
  h.unserializeState(boot);h.writeMemory('system_ram',0x21,new Uint8Array([1]));h.stepFrames(count);
  const active=h.serializeState(),before=digest(h),inputs=Array.from({length:40},(_,f)=>({ports:[{right:f%3===0,a:f%7<3}]}));
  const expected=inputs.map(i=>frame(h,i));
  h.unserializeState(boot);h.unserializeState(active);
  assert.equal(digest(h),before,`active restore after ${count} frames through LCD-off state`);
  assert.deepEqual(h.serializeState(),active);
  assert.deepEqual(inputs.map(i=>frame(h,i)),expected);
 }
});
function fields(snapshot,platform){
 const out=new Map(),dv=new DataView(snapshot.buffer,snapshot.byteOffset,snapshot.byteLength);
 if(platform==='nes'){
  let pos=56;
  while(pos<snapshot.length){const kind=snapshot[pos++],end=pos+4+dv.getUint32(pos,true);pos+=4;
   while(pos<end){const tag=new TextDecoder().decode(snapshot.subarray(pos,pos+4)).replaceAll('\0',''),size=dv.getUint32(pos+4,true);pos+=8;assert.ok(pos+size<=end);out.set(tag,{pos,size,kind});pos+=size;}
  }
 }else{
  let pos=85,end=80+dv.getUint32(4,true);
  while(pos<end){const start=pos;while(snapshot[pos])pos++;const tag=new TextDecoder().decode(snapshot.subarray(start,pos++)),size=(snapshot[pos]<<16)|(snapshot[pos+1]<<8)|snapshot[pos+2];pos+=3;assert.ok(pos+size<=end);out.set(tag,{pos,size});pos+=size;}
 }
 return out;
}
for(const platform of ['gb','gbc'])test(`${platform}: deterministic timing fields remain causal and incompatible envelopes are rejected`,async t=>{
 const h=await host(platform,15,true,undefined,gbFixture(platform==='gbc',false,true));t.after(()=>h.dispose());
 h.stepFrames(12);h.writeMemory('system_ram',0x21,new Uint8Array([1]));h.stepFrames(20);
 const baseline=h.serializeState(),original=digest(h),map=fields(baseline,platform);
 assert.equal(h.stateDigest().schema,0x47420103);
 const active=baseline.slice(),irq=map.get('nm0irq');assert.ok(irq&&irq.size>0);
 active[irq.pos+irq.size-1]^=2;h.unserializeState(active);assert.notEqual(digest(h),original,'active STAT mode-0 deadline');
 for(const at of [64,68,72,76]){
  h.unserializeState(baseline);const changed=baseline.slice();changed[at]=at===72?(baseline[at]===255?0:255):baseline[at]^1;h.unserializeState(changed);
  assert.notEqual(digest(h),original,({64:'native blit deadline',68:'blank-LCD phase',72:'pending OAM scan',76:'OAM size source'})[at]);
 }
 h.unserializeState(baseline);
 for(const [at,value]of [[12,1],[68,2],[72,81],[76,2]]){
  const invalid=baseline.slice();invalid[at]=value;assert.throws(()=>h.unserializeState(invalid),/rejected/);
  assert.equal(digest(h),original,'invalid envelope cannot mutate a live core');
 }
 // Original v1 deterministic envelopes were shorter and carry another schema.
 const old=new Uint8Array(baseline.length-16);old.set(baseline.subarray(0,64));old.set(baseline.subarray(80),64);old[12]=1;
 assert.throws(()=>h.unserializeState(old),/size mismatch|rejected/);assert.equal(digest(h),original);
});

for(const platform of ['gb','gbc','nes'])test(`${platform}: each causal state class participates in the digest`,async t=>{
 const h=await host(platform);t.after(()=>h.dispose());h.setInput({ports:[{a:true}]});h.stepFrames(130);
 const baseline=h.serializeState(),original=digest(h),map=fields(baseline,platform);
 const probes=platform==='nes'?[['A',0,1],['RAM',0,1],['WRAM',0,1],['IQLB',0,1],['TSBS',0,1],['RADD',0,1],['PRAM',1,1],['SPRA',0,1],['JYRB',0,1],['JOYS',0,1],['LEN0',0,1],['WAVE',0,1],['WVHI',0,1],['MRIX',0,1]]:[['a',0,1],['wram',0,1],['hram',0x180+30,1],['sram',0,1],['rambank',0,1],['rtcbase',3,1],['ltimaup',3,16],['serialt',3,1],['vram',0,1],['hram',0,1],['hram',0x100,1],['env1vol',0,1],['dmasrc',0,1]];
 for(const [tag,offset,bit]of probes){const f=map.get(tag);assert.ok(f&&offset<f.size,tag);const changed=baseline.slice();changed[f.pos+offset]^=bit;h.unserializeState(changed);assert.notEqual(digest(h),original,`${tag} causal mutation`);}
 if(platform!=='nes'){
  h.unserializeState(baseline);const clock=baseline.slice();clock[16]^=2;h.unserializeState(clock);assert.notEqual(digest(h),original,'emulated clock');
  const core=80+new DataView(baseline.buffer).getUint32(4,true),audio=baseline.slice();audio[core+16]^=1;h.unserializeState(audio);assert.notEqual(digest(h),original,'audio resampler');
  // endx's upper bits are reconstructible cache representation, not hidden PPU state.
  const cache=baseline.slice();cache[map.get('endx').pos]^=8;h.unserializeState(cache);assert.equal(digest(h),original);
  const inputs=Array.from({length:8},()=>({ports:[{a:true}]}));const expected=inputs.map(i=>frame(h,i));h.unserializeState(baseline);for(let i=0;i<inputs.length;i++)assert.deepEqual(frame(h,inputs[i]),expected[i],'equivalent PPU cache future');
 }
});
test('NES mapper bank registers change digest and subsequent CPU-visible ROM',async t=>{
 const rom=fixtures.nes.slice(),first=rom.slice(16,16+8192),vectors=rom.slice(16+32768-6,16+32768);rom[6]=0x41;
 for(let bank=0;bank<4;bank++){rom.set(first,16+bank*8192);rom[16+bank*8192+0x1ff0]=bank;}rom.set(vectors,16+32768-6);
 const h=await host('nes',15,true,undefined,rom);t.after(()=>h.dispose());h.stepFrames(130);
 const baseline=h.serializeState(),original=digest(h),map=fields(baseline,'nes'),banks=map.get('REGS');assert.ok(banks&&banks.size===8);
 const changed=baseline.slice();changed[banks.pos+6]=1;h.unserializeState(changed);assert.notEqual(digest(h),original);h.stepFrames(2);assert.equal(h.readMemory('system_ram',0x310,1)[0],1);
 h.unserializeState(baseline);h.stepFrames(2);assert.equal(h.readMemory('system_ram',0x310,1)[0],0);
});

// Captured from the pre-M1 pinned cores, not regenerated by the implementation
// under test. MCP state files, auto snapshots and playtest recovery persist them.
const legacy = JSON.parse(readFileSync(new URL('./fixtures/multiplayer/legacy-states.json', import.meta.url), 'utf8'));
const { gunzipSync } = await import('node:zlib');
for (const platform of ['gb', 'gbc', 'nes']) test(`${platform}: ordinary legacy disk state keeps its format and future`, async t => {
 const core = platform === 'nes' ? 'fceumm' : 'gambatte';
 const h = new LibretroHost(); t.after(() => h.dispose());
 await h.loadCore({ factory: (await import(new URL(`romdev-core-${core}/wasm/${core}_libretro.js`, root))).default,
  wasmBinary: readFileSync(new URL(`romdev-core-${core}/wasm/${core}_libretro.wasm`, root)), io: false });
 const rom = platform === 'nes' ? fixtures.nes : gbFixture(platform === 'gbc', true);
 await h.loadMedia({ platform, bytes: rom });
 const saved = legacy.platforms[platform];
 const blob = new Uint8Array(gunzipSync(readFileSync(new URL(`./fixtures/multiplayer/legacy-${platform}.state.gz`, import.meta.url))));
 assert.equal(sha(rom), saved.romSha256);
 assert.equal(sha(blob), saved.stateSha256); assert.equal(blob.length, saved.bytes);
 assert.equal(h.serializeState().length, saved.bytes, 'ordinary core format must not grow');
 h.unserializeState(blob);
 for (let i = 0; i < legacy.inputs.length; i++) {
  const input = legacy.inputs[i]; h.setInput(platform === 'nes' ? input : { ports: input.ports.slice(0, 1) }); h.stepFrames(1);
  assert.deepEqual({ ram: sha(h.readMemory('system_ram', 0, platform === 'nes' ? 2048 : platform === 'gbc' ? 32768 : 8192)),
   pixels: sha(h.screenshotRgba().rgba) }, saved.frames[i], 'legacy restored frame ' + i);
 }
 // Reloading out of rollback restores the same ordinary state format.
 await h.loadMedia({ platform, bytes: rom, deterministic: { rtcEpochSeconds: 0 } });
 assert.ok(h.serializeState().length > saved.bytes);
 await h.loadMedia({ platform, bytes: rom });
 assert.equal(h.serializeState().length, saved.bytes); h.unserializeState(blob);
});

// Fixed tiny bootstrap cartridges: writes to OAM while LCD is off, then enables
// it in the first post-bootstrap frame. The older paused fixture waits longer.
const oamBoot = JSON.parse(readFileSync(new URL('./fixtures/multiplayer/oam-bootstrap.json', import.meta.url), 'utf8'));
for (const platform of ['gb', 'gbc']) test(`${platform}: first post-bootstrap OAM scan survives restore before any displayed frame`, async t => {
 const rom = gunzipSync(Buffer.from(oamBoot[platform], 'base64'));
 const h = await host(platform, 15, true, undefined, rom);
 t.after(() => h.dispose());
 let frames = 0;
 while (h.readMemory('system_ram', 0x10f0, 2)[0] !== 77) {
  h.stepFrames(1); assert.ok(++frames < 120);
 }
 const context = new Uint8Array(32);
 context.set([2,3,4,0,7,7,1,1]); context[12] = 12;
 h.writeMemory('system_ram', 0x400, context);
 const boot = h.serializeState();
 const run = () => Array.from({ length: 12 }, (_, f) => {
  h.writeMemory('system_ram', 0x410, new Uint8Array([f % 2 ? 2 : 1, 2, 1, 0]));
  return frame(h, { ports: [] });
 });
 const expected = run();
 h.unserializeState(boot);
 assert.deepEqual(h.serializeState(), boot);
 assert.deepEqual(run(), expected, 'causal digest, audio, pixels and CPU future match from the very first frame');
});
