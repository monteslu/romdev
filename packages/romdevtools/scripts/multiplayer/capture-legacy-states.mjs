// Capture independent compatibility vectors with the pre-M1 pinned cores.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { LibretroHost } from '../../../romdev-core-host/index.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fourScoreRom } from './tool.mjs';
import { gbFixture } from '../../test/fixtures/multiplayer/gb-fixture.mjs';
const root=path.resolve(import.meta.dirname, '../../../..') + '/';
const oldRepo=process.argv[2];
if(!oldRepo)throw Error('Usage: capture-legacy-states.mjs <pre-M1-repo>');
const source=execFileSync('git',['rev-parse','HEAD'],{cwd:oldRepo,encoding:'utf8'}).trim();
if(source!=='0316acbfa99c0f339d2d74a84b748ae3853f2ffa')throw Error('Legacy capture requires the pinned pre-M1 checkout');
const roms={nes:(await fourScoreRom()).outputs['pads.nes'],gb:gbFixture(false,true),gbc:gbFixture(true,true)};
const sha=b=>createHash('sha256').update(b).digest('hex');
const inputs=Array.from({length:16},(_,f)=>({ports:[{a:f%8<4,right:f%6<3},{b:f%8<4,left:f%6<3}]}));
const metadata={source,inputs,platforms:{}};
for(const platform of ['gb','gbc','nes']){
 const core=platform==='nes'?'fceumm':'gambatte',dir=path.resolve(oldRepo,'packages','romdev-core-'+core,'wasm')+'/';
 const boot=async()=>{const h=new LibretroHost();await h.loadCore({factory:(await import(pathToFileURL(dir+core+'_libretro.js'))).default,wasmBinary:readFileSync(dir+core+'_libretro.wasm'),io:false});await h.loadMedia({platform,bytes:roms[platform]});return h};
 const h=await boot();h.setInput({ports:[{a:true}]});h.stepFrames(130);const state=h.serializeState();h.dispose();
 const restored=await boot();restored.unserializeState(state);
 const frames=inputs.map(input=>{restored.setInput(platform==='nes'?input:{ports:input.ports.slice(0,1)});restored.stepFrames(1);return {ram:sha(restored.readMemory('system_ram',0,platform==='nes'?2048:platform==='gbc'?32768:8192)),pixels:sha(restored.screenshotRgba().rgba)}});
 metadata.platforms[platform]={bytes:state.length,stateSha256:sha(state),coreSha256:sha(readFileSync(dir+core+'_libretro.wasm')),romSha256:sha(roms[platform]),frames};
 writeFileSync(root+'packages/romdevtools/test/fixtures/multiplayer/legacy-'+platform+'.state.gz',gzipSync(state,{mtime:0}));restored.dispose();console.log(platform,state.length);
}
writeFileSync(root+'packages/romdevtools/test/fixtures/multiplayer/legacy-states.json',JSON.stringify(metadata,null,2)+'\n');
