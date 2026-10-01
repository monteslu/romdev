// Small MEMFS runner for the independently runnable M1 compiler/ROM fixtures.
import {readFileSync, readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const packages=path.resolve(import.meta.dirname,'../../..');
export async function tool(name,args,files={},stdin=null) {
 const pkg=['cc65','ca65','ld65'].includes(name)?'cc65':'sdcc';
 const dir=path.join(packages,`romdev-toolchain-${pkg}`,'wasm');
 const factory=(await import(pathToFileURL(path.join(dir,name+'.js')))).default;
 let log='',pos=0,bytes=stdin==null?null:new TextEncoder().encode(stdin);
 const m=await factory({wasmBinary:readFileSync(path.join(dir,name+'.wasm')),noInitialRun:true,thisProgram:"/tools/"+name,stdin:()=>bytes&&pos<bytes.length?bytes[pos++]:null,print:s=>log+=s+'\n',printErr:s=>log+=s+'\n'});
 if (name === "ca65") {
  const share=path.join(packages,"romdev-toolchain-cc65/share/cc65/asminc");
  for (const file of readdirSync(share)) {
   files["/work/"+file]=readFileSync(path.join(share,file));
  }
  args=["-I","/work",...args];
 }
 for(const [file,data] of Object.entries(files)) {
  let p='';for(const part of path.posix.dirname(file).split('/').filter(Boolean)){p+='/'+part;try{m.FS.mkdir(p)}catch{}}
  m.FS.writeFile(file,data);
 }
 const saved=process.exitCode;let code=0;
 try{code=m.callMain(args)??0}catch(e){code=e.status??1;log+=e.message??String(e)}finally{process.exitCode=saved}
 const outputs={};
 for(const f of m.FS.readdir('/work'))if(!f.startsWith('.'))try{outputs[f]=new Uint8Array(m.FS.readFile('/work/'+f))}catch{}
 return {code,log,outputs};
}
export async function fourScoreRom() {
 const fixtures=path.join(packages,'romdevtools/test/fixtures/multiplayer');
 const a=await tool('ca65',['-g','-o','/work/pads.o','/work/pads.s'],{'/work/pads.s':readFileSync(path.join(fixtures,'four-score.s'))});
 if(a.code)throw new Error(a.log);
 const l=await tool('ld65',['--dbgfile','/work/pads.dbg','-m','/work/pads.map','-C','/work/pads.cfg','-o','/work/pads.nes','/work/pads.o'],{'/work/pads.o':a.outputs['pads.o'],'/work/pads.cfg':readFileSync(path.join(fixtures,'four-score.cfg'))});
 if(l.code)throw new Error(l.log);
 return l;
}
