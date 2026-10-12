import {lstat,readdir,realpath,readFile} from 'node:fs/promises'
import {resolve,join,relative,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {executionError} from './execution-artifacts.js'

/** Reference existing native project configuration; never serialize/copy its values. */
export async function discoverProjectRunConfiguration({directory,configurationRoot,service,files=[]}){
 const active=service?.args?.find(arg=>/^--spring\.profiles\.active=|^-Dspring\.profiles\.active=/.test(arg))?.split('=').slice(1).join('=')
 if(!active)return {framework:'configured-command',files:[],profile:null}
 const profiles=active.split(',').map(p=>p.trim()).filter(p=>/^[\w-]+$/.test(p))
 const matches=path=>{const name=path.replaceAll('\\','/').split('/').at(-1);return profiles.some(profile=>new RegExp('^application-'+profile+'\\.(?:ya?ml|properties)$','i').test(name))}
 let root=directory,paths=files.map(f=>typeof f==='string'?f:f.path).filter(matches)
 if(configurationRoot&&isAbsolute(configurationRoot)){
  try{
   if((await lstat(configurationRoot)).isDirectory()){
    const found=[]
    const walk=async(dir,depth=0)=>{for(const item of await readdir(dir,{withFileTypes:true})){if(['.git','node_modules','target','dist','.pnpm-store'].includes(item.name))continue;const path=join(dir,item.name);if(item.isDirectory()&&depth<5)await walk(path,depth+1);else if(item.isFile()&&matches(path))found.push(relative(configurationRoot,path).replaceAll('\\','/'))}}
    await walk(configurationRoot);if(found.length){root=configurationRoot;paths=found}
   }
  }catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error}
 }
 const references=[]
 for(const path of paths.sort()){
  const absolute=join(root,path),metadata=await lstat(absolute)
  if(!metadata.isFile()||metadata.isSymbolicLink()||resolve(await realpath(absolute))!==resolve(absolute))throw executionError('LOCAL_ACCEPTANCE_RUN_CONFIG_UNSAFE')
  references.push({path:absolute,sha256:createHash('sha256').update(await readFile(absolute)).digest('hex')})
 }
 return {framework:'spring',profile:active,root,files:references}
}
export function projectConfiguredService(service,selection){
 if(selection.framework!=='spring'||!selection.files.length)return service
 return {...service,args:[...service.args.filter(arg=>!/^--spring\.config\.(?:additional-location|location)=/.test(arg)),'--spring.config.additional-location='+selection.files.map(f=>'file:'+f.path.replaceAll('\\','/')).join(',')]}
}
export function projectConfiguredBuild(command,selection){
 if(selection.framework!=='spring'||!selection.files.length)return command
 const nativeMaven=/(?:^|[\\/])mvn(?:\.cmd|\.exe)?$/i.test(command.executable)||command.args?.some(arg=>/(?:^|[\\/])mvn(?:\.cmd|\.exe)?$/i.test(arg))
 if(!nativeMaven||command.args.some(arg=>/^-Dspring.profiles.active=/.test(arg)))return command
 return {...command,args:[...command.args.filter(arg=>!/-Dspring\.config\.(?:additional-location|location)=/.test(arg)),'-Dspring.profiles.active='+selection.profile,'-Dspring.config.additional-location='+selection.files.map(f=>'file:'+f.path.replaceAll('\\','/')).join(',')]}
}

export async function assertProjectRunConfiguration(selection){
 for(const file of selection?.files??[]){
  const metadata=await lstat(file.path)
  if(!metadata.isFile()||metadata.isSymbolicLink()||resolve(await realpath(file.path))!==resolve(file.path))throw executionError('LOCAL_ACCEPTANCE_RUN_CONFIG_UNSAFE')
  if(createHash('sha256').update(await readFile(file.path)).digest('hex')!==file.sha256)throw executionError('LOCAL_ACCEPTANCE_RUN_CONFIG_CHANGED')
 }
}
