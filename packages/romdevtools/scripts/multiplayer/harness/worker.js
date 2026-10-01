import {LibretroHost} from './host/index.js';
import {getCPUState} from './host/cpu-state.js';
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const hash=async bytes=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const check=(value,message)=>{if(!value)throw Error(message);};
let live=null;
async function make(platform,mask=15,fixture=platform){
 const name=platform==='nes'?'fceumm':'gambatte';
 const h=new LibretroHost();
 await h.loadCore({factory:(await import('./'+name+'_libretro.js')).default,wasmBinary:new Uint8Array(await(await fetch('./'+name+'_libretro.wasm')).arrayBuffer()),io:false});
 await h.loadMedia({platform,bytes:new Uint8Array(await(await fetch('./'+fixture+'.rom')).arrayBuffer()),deterministic:{rtcEpochSeconds:0},...(platform==='nes'?{controllerTopology:{kind:'nes',playerMask:mask}}:{})});return h;
}
function trace(h,input){
 h.setInput(input);h.state.audioRing.length=0;h.stepFrames(1);
 const audio=h.state.audioRing.flatMap(a=>Array.from(a));
 return {state:hex(h.stateDigest().bytes),pixels:h.screenshotRgba().rgba.slice(),audio,regs:JSON.stringify(getCPUState(h,h.status.platform)),ram:h.readMemory('system_ram',0,h.status.platform==='nes'?2048:h.status.platform==='gbc'?32768:8192)};
}
async function verifyBootstrap(platform){
 const h=await make(platform,15,platform+'-offlcd');
 try{
  h.stepFrames(12);check(h.readMemory('system_ram',0x20,1)[0]===0x5a,'Bootstrap wait was not reached');
  for(const wait of [0,1,5,30]){
   h.stepFrames(wait);check(h.readMemory('system_ram',0x21,1)[0]===0,'World started before configuration');
   const snapshot=h.serializeState();
   const inputs=Array.from({length:40},(_,f)=>({ports:[{right:f%3===0,a:f%7<3}]}));
   const run=()=>inputs.map((input,f)=>{if(f===8)h.writeMemory('system_ram',0x21,new Uint8Array([1]));return trace(h,input);});
   const expected=run();h.unserializeState(snapshot);
   check(hex(h.stateDigest().bytes)===await hash(snapshot),'LCD-off bootstrap digest differs');
   const actual=run();
   for(let f=0;f<inputs.length;f++){
    const a=actual[f],e=expected[f];
    check(a.state===e.state&&equal(a.pixels,e.pixels)&&equal(a.audio,e.audio)&&a.regs===e.regs&&equal(a.ram,e.ram),'LCD-off / sprite / STAT replay differs at frame '+f);
   }
   h.unserializeState(snapshot);
  }
  const boot=h.serializeState(),inputs=Array.from({length:40},(_,f)=>({ports:[{right:f%3===0,a:f%7<3}]}));
  for(const count of [1,2,3,8,30]){
   h.unserializeState(boot);h.writeMemory('system_ram',0x21,new Uint8Array([1]));h.stepFrames(count);
   const active=h.serializeState(),expected=inputs.map(input=>trace(h,input));
   h.unserializeState(boot);h.unserializeState(active);
   check(hex(h.stateDigest().bytes)===await hash(active),'Active state after LCD-off restore differs');
   for(let f=0;f<inputs.length;f++){
    const a=trace(h,inputs[f]),e=expected[f];
    check(a.state===e.state&&equal(a.pixels,e.pixels)&&equal(a.audio,e.audio)&&a.regs===e.regs&&equal(a.ram,e.ram),'Active / dormant-sprite restore differs at frame '+f);
   }
  }
  return 'LCD-off bootstrap and resume (4 checkpoints × 40 frames); active restore through LCD-off (5 checkpoints × 40 frames)';
 }finally{h.dispose();}
}
async function verify(platform){
 const a=await make(platform);await new Promise(r=>setTimeout(r,1100));const b=await make(platform);
 try{
 a.stepFrames(130);b.stepFrames(130);check(equal(a.stateDigest().bytes,b.stateDigest().bytes),'Independent boot differs');
 const snapshot=a.serializeState();check(hex(a.stateDigest().bytes)===await hash(snapshot),'Core digest differs from SHA-256 reference');
 const inputs=Array.from({length:32},(_,f)=>({ports:Array.from({length:platform==='nes'?4:1},(_,p)=>({right:(f+p)%12<6,a:(f+p)%8<4,b:f%7<3}))}));
 const expected=inputs.map(input=>trace(a,input));check(expected.some(f=>f.audio.some(v=>v!==0)),"Fixture produces audible samples");a.unserializeState(snapshot);
 check(hex(a.stateDigest().bytes)===await hash(snapshot),'Restored digest differs');
 for(let f=0;f<inputs.length;f++){
  const actual=trace(a,inputs[f]),e=expected[f];
  check(actual.state===e.state&&equal(actual.pixels,e.pixels)&&equal(actual.audio,e.audio)&&actual.regs===e.regs&&equal(actual.ram,e.ram),'Replay differs at frame '+f);
 }
 if(platform==='nes')for(const mask of [1,3,7,15,5,9]){
  await a.loadMedia({platform,bytes:new Uint8Array(await(await fetch('./nes.rom')).arrayBuffer()),deterministic:{rtcEpochSeconds:0},controllerTopology:{kind:'nes',playerMask:mask}});
  a.stepFrames(12);a.setInput({ports:[{a:true},{b:true},{select:true},{start:true}]});a.stepFrames(4);
  const pads=a.readMemory('system_ram',0x300,6),want=[mask&1?1:0,mask&2?2:0,...(mask>3?[mask&4?4:0,mask&8?8:0,8,4]:[255,255,255,255])];check(equal(pads,want),'Native pads / Four Score signature differs for mask '+mask);
 }
 if(platform==='gbc')check(a.readMemory('system_ram',0x400,1)[0]===0xa5&&a.readMemory('system_ram',0x10f0,1)[0]===0x5a&&a.readMemory('system_ram',0x20f0,1)[0]===0x99,'Banked header/context probe differs');
 const bootstrap=platform==='nes'?[]:[await verifyBootstrap(platform)];
 return {platform,pass:true,schema:a.stateDigest().schema,snapshotBytes:snapshot.length,framesCompared:32,checks:[...bootstrap,'independent boot','digest SHA-256','restore','future digest/RAM/registers/pixels/audio',...(platform==='nes'?['1–4 native pads','gapped slots','Four Score signatures']:platform==='gbc'?['WRAM bank/context']:[])]};
 }finally{a.dispose();b.dispose();}
}
onmessage=async({data})=>{
 try{
 if(data.op==='verify'){postMessage({op:'verified',result:await verify(data.platform)});}
 else if(data.op==='play'){
  live=await make('nes');let frame=0;
  setInterval(()=>{live.state.audioRing.length=0;live.stepFrames(1);const image=live.screenshotRgba();if(++frame%2===0)postMessage({op:'frame',rgba:image.rgba,width:image.width,height:image.height,pads:Array.from(live.readMemory('system_ram',0x300,6)),positions:Array.from(live.readMemory('system_ram',0x308,4))},[image.rgba.buffer]);},1000/60.0988);
 }else if(data.op==='input'&&live)live.setInput({ports:data.ports});
 }catch(e){postMessage({op:'error',message:e.message,stack:e.stack});}
};
