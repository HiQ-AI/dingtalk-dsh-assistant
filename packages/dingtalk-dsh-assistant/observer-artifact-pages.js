import {createHash,randomUUID} from 'node:crypto'
import {open,stat,lstat,link,unlink,readFile,rename} from 'node:fs/promises'
const chunkUnits=4096
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const error=code=>Object.assign(new Error(code),{code})
const files=(path,view)=>{const base=`${path}.observer-${digest(view).slice(0,32)}`;return {meta:base+'.json',text:base+'.utf16',hashes:base+'.hashes'}}
const identity=info=>({size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs})
// Windows scanners/readers may briefly deny replacing a just-published manifest.
// Retry only the explicit offline replacement, never unlink the destination.
export async function replaceObserverArtifactFile(source,destination,{renameFile=rename,platform=process.platform,clock=()=>performance.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 const deadline=clock()+1000;let delay=25
 for(;;){
  try{return await renameFile(source,destination)}
  catch(cause){
   const remaining=deadline-clock()
   if(platform!=='win32'||!['EPERM','EBUSY','EACCES'].includes(cause.code)||remaining<=0)throw cause
   await wait(Math.min(delay,remaining));delay=Math.min(200,delay*2)
  }
 }
}
async function immutable(path,bytes,{replace=false}={}){
 const temp=path+'.pending-'+randomUUID();let file
 try{file=await open(temp,'wx');await file.writeFile(bytes);await file.sync();await file.close();file=null;if(replace)await replaceObserverArtifactFile(temp,path);else await link(temp,path)}
 catch(cause){if(cause.code!=='EEXIST')throw cause;if(!(await readFile(path)).equals(bytes))throw error('OBSERVER_TEXT_INDEX_CONFLICT')}
 finally{await file?.close();await unlink(temp).catch(cause=>{if(cause.code!=='ENOENT')throw cause})}
}
// Write only while publishing the content-addressed artifact or in an explicit
// offline migration. This function is never called by the HTTP read path.
export async function writeObserverArtifactText(path,view,text,extra={},options={}){
 if(typeof text!=='string')throw error('OBSERVER_TEXT_INVALID')
 const names=files(path,view),bytes=Buffer.from(text,'utf16le');let leaves=1
 while(leaves<Math.ceil(text.length/chunkUnits))leaves*=2
 const tree=Array(leaves*2-1)
 for(let leaf=0;leaf<leaves;leaf++)tree[leaves-1+leaf]=Buffer.from(digest(bytes.subarray(leaf*chunkUnits*2,(leaf+1)*chunkUnits*2)),'hex')
 for(let node=leaves-2;node>=0;node--)tree[node]=Buffer.from(digest(Buffer.concat([tree[node*2+1],tree[node*2+2]])),'hex')
 const meta={version:2,view,...extra,identity:identity(await stat(path)),totalLength:text.length,totalBytes:Buffer.byteLength(text),hash:digest(JSON.stringify(text)),leaves,merkleRoot:tree[0].toString('hex')}

 const header=Buffer.from(JSON.stringify(meta));if(header.length>8192)throw error('OBSERVER_TEXT_METADATA_TOO_LARGE')
 await immutable(names.text,bytes,options);await immutable(names.hashes,Buffer.concat(tree),options);await immutable(names.meta,header,options)
 return {...meta,bindingRoot:digest(header)}
}
async function exact(file,length,position){const buffer=Buffer.alloc(length);let count=0;while(count<length){const part=await file.read(buffer,count,length-count,position+count);if(!part.bytesRead)throw error('OBSERVER_TEXT_INDEX_INVALID');count+=part.bytesRead}return buffer}
export async function readObserverArtifactText(path,view,{offset=0,limit=2000,hash=null,requireHash=false,onRead,bindingRoot}={}){
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<2||limit>8000)throw error('OBSERVER_TEXT_CURSOR_INVALID')
 if(!bindingRoot)throw error('OBSERVER_TEXT_BINDING_REQUIRED')
 const names=files(path,view);let header,textFile,hashFile
 try{
  const entry=await lstat(names.meta);if(!entry.isFile()||entry.isSymbolicLink()||entry.size>8192)throw error('OBSERVER_TEXT_INDEX_INVALID')
  header=await open(names.meta,'r');const encoded=await exact(header,entry.size,0);onRead?.({kind:'meta',bytes:encoded.length});if(digest(encoded)!==bindingRoot)throw error('OBSERVER_TEXT_BINDING_MISMATCH');const meta=JSON.parse(encoded)
  if(meta.version!==2||meta.view!==view||!Number.isSafeInteger(meta.leaves)||meta.leaves<1||!Number.isSafeInteger(meta.totalLength)||meta.totalLength<0||!(await lstat(path)).isFile()||(await lstat(path)).isSymbolicLink()||JSON.stringify(identity(await stat(path)))!==JSON.stringify(meta.identity))throw error('ARTIFACT_DIGEST_MISMATCH')
  if(hash&&hash!==meta.hash)throw error('MESSAGE_EVIDENCE_VERSION_CHANGED')
  if(offset>meta.totalLength||offset>0&&requireHash&&!hash)throw error('OBSERVER_TEXT_CURSOR_INVALID')
  const startChunk=Math.floor(offset/chunkUnits),endChunk=Math.floor(Math.min(meta.totalLength,offset+limit)/chunkUnits)
  for(const name of [names.text,names.hashes]){const entry=await lstat(name);if(!entry.isFile()||entry.isSymbolicLink())throw error('OBSERVER_TEXT_INDEX_INVALID')}
  textFile=await open(names.text,'r');hashFile=await open(names.hashes,'r')
  const chunks=[]
  for(let chunk=startChunk;chunk<=endChunk&&chunk*chunkUnits<meta.totalLength;chunk++){
   const bytes=await exact(textFile,Math.min(chunkUnits,meta.totalLength-chunk*chunkUnits)*2,chunk*chunkUnits*2)
   onRead?.({kind:'text',bytes:bytes.length});let node=meta.leaves-1+chunk,proof=Buffer.from(digest(bytes),'hex')
   while(node>0){const sibling=node%2===1?node+1:node-1,other=await exact(hashFile,32,sibling*32);onRead?.({kind:'hash',bytes:32});proof=Buffer.from(digest(node%2===1?Buffer.concat([proof,other]):Buffer.concat([other,proof])),'hex');node=Math.floor((node-1)/2)}
   if(proof.toString('hex')!==meta.merkleRoot)throw error('OBSERVER_TEXT_INDEX_INVALID')
   chunks.push(bytes)
  }
  const selected=Buffer.concat(chunks).toString('utf16le'),start=offset-startChunk*chunkUnits
  if(offset>0&&/[\uDC00-\uDFFF]/u.test(selected[start]??''))throw error('OBSERVER_TEXT_CURSOR_INVALID')
  let end=Math.min(meta.totalLength,offset+limit)
  if(end<meta.totalLength&&/[\uD800-\uDBFF]/u.test(selected[end-offset+start-1]??''))end--
  if(JSON.stringify(identity(await stat(path)))!==JSON.stringify(meta.identity))throw error('ARTIFACT_DIGEST_MISMATCH')
  return {...meta,start:offset,end,text:selected.slice(start,start+end-offset),complete:offset===0&&end===meta.totalLength,nextCursor:end<meta.totalLength?end:null}
 }catch(cause){if(cause.code==='ENOENT')throw error('OBSERVER_TEXT_MIGRATION_REQUIRED');throw cause}
 finally{await header?.close();await textFile?.close();await hashFile?.close()}
}
