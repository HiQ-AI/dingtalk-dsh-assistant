import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { executionDigest, executionError } from './execution-artifacts.js'
const exec = promisify(execFile)
const git = async (repository, args) => (await exec('git', ['-C', repository, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout.trim()
const fail = code => { throw executionError(code) }
export async function inspectDevelopmentBranch({repository, sourceCommit, headCommit, targetCommit}) {
  for (const oid of [sourceCommit, headCommit, targetCommit].filter(Boolean)) if (!/^[a-f0-9]{40}$/.test(oid)) fail('ENGINEERING_BRANCH_EVIDENCE_INVALID')
  const commits = (await git(repository, ['rev-list', '--parents', sourceCommit + '..' + headCommit])).split('\n').filter(Boolean).map(line => { const [commit, ...parents] = line.split(' '); return {commit, parents} })
  const targetOnly = new Set(targetCommit ? (await git(repository, ['rev-list', sourceCommit + '..' + targetCommit])).split('\n').filter(Boolean) : [])
  const targetMerges = commits.filter(c => c.parents.length > 1 && c.parents.some(p => targetOnly.has(p)))
  let sourceAncestor
  try { sourceAncestor = await git(repository, ['merge-base', sourceCommit, headCommit]) === sourceCommit }
  catch(error) { if(error.code!==1) throw error; sourceAncestor=false }
  const body = {sourceCommit, headCommit, targetCommit: targetCommit ?? null, sourceAncestor, commits, targetMerges,
    diff: await git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--binary', sourceCommit, headCommit, '--']),
    targetDiff: targetCommit ? await git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--binary', targetCommit, headCommit, '--']) : null}
  return {...body, digest: executionDigest(body)}
}
// Deterministic ancestry selection happens before any workspace or delivery identity.
// Other increments belong to the existing engineering analysis, not a second assessor.
export async function selectDevelopmentBaseline({repository, sourceCommit, headCommit, targetCommit, existingBranch, newBranch}) {
  if (!headCommit) return {head:newBranch, baseCommit:sourceCommit, disposition:'created'}
  const evidence = await inspectDevelopmentBranch({repository, sourceCommit, headCommit, targetCommit})
  const reusable = evidence.sourceAncestor && !evidence.targetMerges.length
  return {head:reusable ? existingBranch : newBranch, baseCommit:reusable ? headCommit : sourceCommit,
    disposition:reusable ? 'reused' : 'rebuilt', ...(reusable ? {} : {retiredHead:existingBranch}), evidence}
}

export async function resolveDevelopmentSource({repository,remote,baseRef,baseBranch}) {
  let ref=baseRef ?? (baseBranch ? `refs/heads/${baseBranch}` : undefined)
  if (!ref) {
    const advertised=await git(repository,['ls-remote','--symref','--',remote,'HEAD'])
    ref=advertised.match(/^ref: (refs\/heads\/[^\s]+)\s+HEAD$/m)?.[1]
    if(!ref) fail('ENGINEERING_REPOSITORY_DEFAULT_UNAVAILABLE')
  }
  if(ref.startsWith('-') || /[\s\0]/.test(ref)) fail('ENGINEERING_DEVELOPMENT_SOURCE_INVALID')
  // Explicit local refs/commits win. An omitted source is the actual remote default.
  if(baseRef || baseBranch) {
    try { return {ref,commit:await git(repository,['rev-parse','--verify',`${ref}^{commit}`])} }
    catch(error) { if(error.code!==128) throw error }
  }
  const advertised=await git(repository,['ls-remote','--refs','--',remote,ref])
  const commit=advertised.split(/\s/)[0]
  if(!/^[a-f0-9]{40}$/.test(commit)) fail('ENGINEERING_DEVELOPMENT_SOURCE_NOT_FOUND')
  await git(repository,['fetch','--no-tags','--no-write-fetch-head','--',remote,commit])
  return {ref,commit}
}

// Read the frozen retired Git tree without checking it out or importing its ancestry.
export async function readDevelopmentSnapshot({repository,headCommit,signal}) {
  if(!/^[a-f0-9]{40}$/.test(headCommit??''))fail('ENGINEERING_BRANCH_EVIDENCE_INVALID')
  const options={windowsHide:true,maxBuffer:32*1024*1024,signal}
  const tree=(await exec('git',['--no-replace-objects','-C',repository,'ls-tree','-r','-z',headCommit],{...options,encoding:'utf8'})).stdout
  const files=tree.split('\0').filter(Boolean).flatMap(entry=>{
    const tab=entry.indexOf('\t'),[mode,type,objectId]=entry.slice(0,tab).split(' '),path=entry.slice(tab+1)
    return ['100644','100755'].includes(mode)&&type==='blob'&&/^[a-f0-9]{40}$/.test(objectId)?[{path,objectId}]:[]
  })
  return {files,async readFile(path){const file=files.find(file=>file.path===path);if(!file)fail('ENGINEERING_READ_PATH_INVALID');return (await exec('git',['--no-replace-objects','-C',repository,'cat-file','blob',file.objectId],{...options,encoding:null})).stdout}}
}
