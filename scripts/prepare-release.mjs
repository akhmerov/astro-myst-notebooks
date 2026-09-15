import { readFile, writeFile } from 'node:fs/promises';
// These bundled manifests must declare the versions actually shipped. An
// override alone leaves npm ci trying to restore the old vulnerable ranges.
const patches=JSON.parse(await readFile('scripts/dependency-patches.json','utf8'));
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const originals=[];
for(const patch of patches) {
  const path=`node_modules/${patch.package}/package.json`;
  const original=await readFile(path,'utf8');
  const pkg=JSON.parse(original);
  if(pkg.version!==patch.version || pkg.dependencies[patch.dependency]!==patch.from) throw new Error(`Review the release dependency patch for ${patch.package}`);
  originals.push({path,original});
}
await writeFile('.release-manifests.json',JSON.stringify(originals));
for(const [index,patch] of patches.entries()) {
  const pkg=JSON.parse(originals[index].original);
  pkg.dependencies[patch.dependency]=patch.to;
  await writeFile(originals[index].path,JSON.stringify(pkg,null,2)+'\n');
  lock.packages[`node_modules/${patch.package}`].dependencies[patch.dependency]=patch.to;
}
lock.packages=Object.fromEntries(Object.entries(lock.packages).filter(([path,entry])=>!path || !entry.dev));
delete lock.packages[''].devDependencies;
await writeFile('npm-shrinkwrap.json',JSON.stringify(lock,null,2)+'\n');
await writeFile('dist/DEPENDENCY-PATCHES.json',JSON.stringify(patches,null,2)+'\n');
