import { readFile, rm, writeFile } from 'node:fs/promises';
try {
  for(const {path,original} of JSON.parse(await readFile('.release-manifests.json','utf8'))) await writeFile(path,original);
} catch(error) { if(error.code!=='ENOENT') throw error; }
await rm('.release-manifests.json',{force:true});
await rm('npm-shrinkwrap.json',{force:true});
