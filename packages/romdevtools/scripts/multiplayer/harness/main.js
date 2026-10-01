const status=document.querySelector('#status'),report=document.querySelector('#report'),canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
const manifest=await(await fetch('./manifest.json')).json();
const result={...manifest,userAgent:navigator.userAgent,checks:[]};
document.querySelector('#source').href='https://github.com/ssk-play/romdev/tree/'+manifest.sourceCommit;
const renderReport=()=>{report.textContent=JSON.stringify(result,null,2);};
renderReport();
let play,lastPositions=0;
try{
 for(const platform of ['gb','gbc','nes']){
  status.textContent='Checking '+platform.toUpperCase()+'…';
  const worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
  let timeout;
  try{const check=await new Promise((resolve,reject)=>{
   timeout=setTimeout(()=>reject(Error(platform.toUpperCase()+" check timed out")),60000);
   worker.onmessage=({data})=>{if(data.op==='verified')resolve(data.result);else if(data.op==='error')reject(Error(data.message));};
   worker.onerror=e=>reject(Error(e.message));worker.postMessage({op:'verify',platform});
  });result.checks.push(check);renderReport();}finally{clearTimeout(timeout);worker.terminate();}
 }
 status.textContent='PASS · GB, GBC and NES rollback checks. Try all four players below.';result.pass=true;renderReport();
 play=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
 play.onmessage=({data})=>{if(data.op==='frame'){canvas.width=data.width;canvas.height=data.height;ctx.putImageData(new ImageData(new Uint8ClampedArray(data.rgba.buffer,data.rgba.byteOffset,data.rgba.byteLength),data.width,data.height),0,0);canvas.dataset.pads=data.pads.join(',');canvas.dataset.positions=data.positions.join(',');if(performance.now()-lastPositions>500){document.querySelector('#positions').textContent=data.positions.map((v,i)=>'P'+(i+1)+': '+v).join(' · ');lastPositions=performance.now();}}else if(data.op==='error')status.textContent=data.message;};
 play.postMessage({op:'play'});
}catch(e){result.pass=false;result.error=e.message;status.textContent='FAIL · '+e.message;renderReport();}
const pads=[{},{},{},{}],held=new Map();
const send=()=>play?.postMessage({op:'input',ports:pads});
for(const button of document.querySelectorAll('[data-pad]')){
 button.onpointerdown=e=>{e.preventDefault();button.setPointerCapture(e.pointerId);const slot=+document.querySelector('#slot').value,key=button.dataset.pad;held.set(e.pointerId,{slot,key});pads[slot][key]=true;send();};
 const release=e=>{const h=held.get(e.pointerId);if(!h)return;held.delete(e.pointerId);pads[h.slot][h.key]=Array.from(held.values()).some(v=>v.slot===h.slot&&v.key===h.key);send();};
 button.onpointerup=release;button.onpointercancel=release;button.onlostpointercapture=release;
}
window.onblur=()=>{held.clear();pads.forEach(p=>Object.keys(p).forEach(k=>p[k]=false));send();};
document.querySelector('#copy').onclick=async()=>{await navigator.clipboard.writeText(JSON.stringify(result,null,2));document.querySelector('#copy').textContent='Copied';};
