// Stage a separate, read-only core test program into romdev-browser's dist.
// chiptoy serves this program as an asset; it never imports its implementation.
import {cpSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fourScoreRom} from './tool.mjs';
import {gbFixture} from '../../test/fixtures/multiplayer/gb-fixture.mjs';
const repo=path.resolve(import.meta.dirname,'../../../..');
const dist=process.argv[2];
if(!dist)throw Error('Usage: node build-harness.mjs <romdev-browser/dist>');
const out=path.join(dist,'m1');mkdirSync(out,{recursive:true});
for(const name of ['index.html','main.js','worker.js'])cpSync(path.join(import.meta.dirname,'harness',name),path.join(out,name));
const hostDir=path.join(repo,'packages/romdev-core-host');mkdirSync(path.join(out,'host'),{recursive:true});
for(const name of (await import('node:fs')).readdirSync(hostDir).filter(n=>n.endsWith('.js')&&!n.endsWith('.test.js')))cpSync(path.join(hostDir,name),path.join(out,'host',name));
const roms={nes:(await fourScoreRom()).outputs['pads.nes'],gb:gbFixture(false),gbc:gbFixture(true),'gb-offlcd':gbFixture(false,false,true),'gbc-offlcd':gbFixture(true,false,true)};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const artifacts={};for(const [name,bytes]of Object.entries(roms)){writeFileSync(path.join(out,name+'.rom'),bytes);artifacts[name+'.rom']=hash(bytes);}
for(const core of ['gambatte','fceumm'])for(const ext of ['js','wasm']){
 const name=core+'_libretro.'+ext,src=path.join(repo,'packages',`romdev-core-${core}`,'wasm',name);cpSync(src,path.join(out,name));artifacts[name]=hash(readFileSync(src));
}
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
writeFileSync(path.join(out,'manifest.json'),JSON.stringify({milestone:'M1',sourceCommit,artifacts},null,2)+'\n');
cpSync(path.join(dist,'LICENSE'),path.join(out,'LICENSE'));
const versions=JSON.parse(readFileSync(path.join(repo,'packages/romdevtools/scripts/versions.json'),'utf8'));
const source='https://github.com/ssk-play/romdev/tree/'+sourceCommit;
const notices=['# Core verification program notices','',
 'This program redistributes the GPL emulator cores as separate WASM modules. LICENSE contains GPL version 2; LICENSE-host contains the MIT license for the host and test fixtures.', '',
 'Corresponding source and rebuild recipes for this exact harness: '+source+'.', '',
 'The host and fixtures come from packages/romdev-core-host and packages/romdevtools/scripts/multiplayer plus test/fixtures/multiplayer in that source tree.', ''];
for(const core of ['gambatte','fceumm']){
 const pkg=JSON.parse(readFileSync(path.join(repo,'packages',`romdev-core-${core}`,'package.json'),'utf8')),pin=versions.cores[core];
 notices.push(`- ${core} (${pkg.name} ${pkg.version}, ${pkg.license}): ${pin.url.replace(/\.git$/,'')}/tree/${pin.commit}, with the patches and pinned build recipe at ${source}/packages/romdevtools/scripts/build-${core}.sh.`);
}
notices.push('', 'Rebuild from the source checkout with ROMDEV_BUILD_CWD=packages/romdevtools build-image/build-wasm.sh build-gambatte.sh (and build-fceumm.sh), then run build-harness.mjs. The published payload manifest pins the same core binaries. Manifest.json records SHA-256 for every ROM/core artifact.');
writeFileSync(path.join(out,'NOTICE.md'),notices.join('\n')+'\n');
cpSync(path.join(repo,'packages/romdevtools/LICENSE'),path.join(out,'LICENSE-host'));
console.log('M1 harness staged:',out,sourceCommit);
