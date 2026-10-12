import { executionDigest } from './execution-artifacts.js'
import { readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path'

const fail = code => { throw Object.assign(Error(code), { code }) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const run = (command, args) => new Promise((yes, no) => execFile(command, args,
  { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000 },
  (error, output) => error ? no(Object.assign(Error('TASK_DELIVERY_REVIEW_QUERY_FAILED'), { code: 'TASK_DELIVERY_REVIEW_QUERY_FAILED' })) : yes(output)))
/** Read actual already-delivered facts. Only the original Owner judges requirement sufficiency. */
export async function verifyDeliveredEngineeringFacts({ taskId, requirement, repository, input, repositories = [repository], queryCommand = run, requireDraft = true, allowMerged = false }) {
  if (input.kind === 'project-evidence') return verifyProjectEvidence({ taskId, requirement, repository, repositories, input, queryCommand, requireDraft, allowMerged })
  const directory = await realpath(input.directory), request = requirement.request?.replaceAll('\\', '/') ?? ''
  if (!request.includes(directory.replaceAll('\\', '/'))) fail('TASK_DELIVERY_REVIEW_DIRECTORY_NOT_AUTHORIZED')
  // External evidence must lie in paths explicitly referenced by the authorized current requirement.
  const authorizedPaths = [...request.matchAll(/[A-Za-z]:[\/][^\s，；。\u4e00-\u9fff]+/g)].map(match => match[0].replace(/[,;.)]+$/, ''))
  async function externalPath(path) {
    const actual = await realpath(path), normalized = actual.replaceAll('\\', '/').toLowerCase()
    if (!authorizedPaths.some(value => {
      const root = (/\.[a-z0-9]+$/i.test(value) ? dirname(value) : value).replaceAll('\\', '/').toLowerCase()
      return normalized === root || normalized.startsWith(root + '/')
    })) fail('TASK_DELIVERY_REVIEW_EVIDENCE_SCOPE_INVALID')
    return actual
  }
  const expected = repository.githubRepository ?? repository.remote?.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
  if (input.repository !== expected || requirement.target?.repositoryId !== repository.id) fail('TASK_DELIVERY_REVIEW_REPOSITORY_MISMATCH')
  const git = async (...args) => (await queryCommand(process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git',
    ['-c', 'safe.directory=' + directory, '-C', directory, ...args])).trim()
  const commit = await git('rev-parse', 'HEAD')
  if (commit !== input.commit || await git('status', '--porcelain')) fail('TASK_DELIVERY_REVIEW_SOURCE_CHANGED')
  const proofPath = resolve(directory, input.verificationFile)
  if (isAbsolute(input.verificationFile) || relative(directory, proofPath).split(sep).includes('..')) fail('TASK_DELIVERY_REVIEW_EVIDENCE_SCOPE_INVALID')
  const file = await readFile(proofPath), proof = JSON.parse(file)
  if (!/^[a-f0-9]{40}$/.test(proof.sourceBase) || proof.taskId !== taskId || proof.originalRunId !== input.runId || proof.deployed !== false || proof.nativeRunReexecuted !== false
    ) fail('TASK_DELIVERY_REVIEW_EVIDENCE_SCOPE_INVALID')
  for (const item of proof.applicability?.proof ?? []) {
    if (isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..')) fail('TASK_DELIVERY_REVIEW_EVIDENCE_SCOPE_INVALID')
    const bytes = await readFile(resolve(directory, item.path))
    if (hash(bytes.toString('utf8').replaceAll('\r\n', '\n')) !== item.canonicalSha256) fail('TASK_DELIVERY_REVIEW_SOURCE_CHANGED')
  }
  // Compatibility input: preserve actual evidence bytes/hashes without prescribing artifact formats.
  const reports = []
  for (const item of proof.directedTests?.reports ?? []) {
    if (isAbsolute(item.file) || item.file.split(/[\\/]/).includes('..')) fail('TASK_DELIVERY_REVIEW_EVIDENCE_SCOPE_INVALID')
    const bytes = await readFile(resolve(directory, 'target/surefire-reports', item.file))
    reports.push({ file: item.file, sha256: hash(bytes), content: bytes.toString('utf8') })
  }
  const evidence = []
  for (const [path, expected] of [[input.businessJUnitPath, proof.realPostgres?.junitSha256], [input.cleanupPath, input.cleanupSha256], [input.jarPath, input.jarSha256]]) {
    if (!path) continue
    const actual = await externalPath(path), bytes = await readFile(actual)
    if (expected && hash(bytes) !== expected) fail('TASK_DELIVERY_REVIEW_EVIDENCE_CHANGED')
    evidence.push({ path: actual, sha256: hash(bytes), content: bytes.length <= 131072 ? bytes.toString('utf8') : null })
  }
  const pr = JSON.parse(await queryCommand(process.platform === 'win32' ? 'C:/Program Files/GitHub CLI/gh.exe' : 'gh',
    ['pr', 'view', String(input.prNumber), '--repo', expected, '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergedAt']))
  if (pr.number!==input.prNumber || pr.state !== 'OPEN' || !pr.isDraft || pr.mergedAt || pr.headRefOid !== commit || pr.headRefName !== await git('branch', '--show-current')
    || pr.baseRefName !== `feature/${requirement.target.uatEnvironment}-base`) fail('TASK_DELIVERY_REVIEW_PR_MISMATCH')
  const sourcePatch = await git('diff', '--no-ext-diff', '--no-textconv', proof.sourceBase, commit)
  return { kind: 'verified-delivered-engineering-facts', taskId, runId: input.runId, repository: expected, directory, commit, pr,
    sourcePatch, unitReports: reports, evidence,
    verificationSha256: hash(file), scope: { submitted: { fullApplicationStarted: proof.fullAppStarted, realNotificationsVerified: proof.realNotificationsVerified }, deployed: false }, sourceInput: input }
}

/** Verify identity and bytes, not the author's acceptance claims. Owner reads and judges evidence. */
async function verifyProjectEvidence({ taskId, requirement, repository, repositories, input, queryCommand, requireDraft = true, allowMerged = false }) {
  const request = [requirement.request ?? '', ...(Array.isArray(requirement.constraints) ? requirement.constraints.filter(value=>typeof value==='string') : [])].join('\n').replaceAll('\\', '/').toLowerCase()
  const roots = [...request.matchAll(/(?:[a-z]:\/|\/)[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef,;()"']+/g)].map(match => match[0].replace(/[.,;]+$/, ''))
  const authorized = path => {
    const value = path.replaceAll('\\', '/').toLowerCase()
    return roots.some(root => value === root || value.startsWith(root + '/'))
  }
  if (repository.id !== requirement.target?.repositoryId) fail('TASK_DELIVERY_REVIEW_REPOSITORY_MISMATCH')
  if (!input.projects?.length || !input.evidence?.length) fail('TASK_DELIVERY_REVIEW_EVIDENCE_SCOPE_INVALID')
  const projects = [], names = new Set()
  for (const item of input.projects) {
    const configured = repositories.find(value => (value.githubRepository ?? value.remote?.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]) === item.repository)
    if (!configured || names.has(item.repository)) fail('TASK_DELIVERY_REVIEW_REPOSITORY_MISMATCH')
    names.add(item.repository)
    const directory = await realpath(item.directory)
    if (!authorized(directory)) fail('TASK_DELIVERY_REVIEW_DIRECTORY_NOT_AUTHORIZED')
    const git = async (...args) => (await queryCommand(process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git', ['-c', 'safe.directory=' + directory, '-C', directory, ...args])).trim()
    const commit = await git('rev-parse', 'HEAD')
    if (commit !== item.commit || await git('status', '--porcelain', '--untracked-files=no')) fail('TASK_DELIVERY_REVIEW_SOURCE_CHANGED')
    const remote = await git('remote', 'get-url', 'origin')
    let actualRepository = remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
    if (!actualRepository && isAbsolute(remote)) {
      // Existing engineering clones may use the local source mirror as origin.
      const mirror = await realpath(remote)
      const upstream = (await queryCommand(process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git', ['-c', 'safe.directory=' + mirror, '-C', mirror, 'remote', 'get-url', 'origin'])).trim()
      actualRepository = upstream.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
    }
    if (actualRepository !== item.repository) fail('TASK_DELIVERY_REVIEW_REPOSITORY_MISMATCH')
    const pr = JSON.parse(await queryCommand(process.platform === 'win32' ? 'C:/Program Files/GitHub CLI/gh.exe' : 'gh', ['pr', 'view', String(item.prNumber), '--repo', item.repository, '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergedAt']))
    if (pr.number!==item.prNumber || !(pr.state==='OPEN' && (!requireDraft||pr.isDraft) && !pr.mergedAt || allowMerged && pr.state==='MERGED' && pr.mergedAt) || pr.headRefOid !== commit || pr.headRefName !== await git('branch', '--show-current') || pr.baseRefName !== `feature/${requirement.target.uatEnvironment}-base`) fail('TASK_DELIVERY_REVIEW_PR_MISMATCH')
    if (!/^[a-f0-9]{40}$/.test(item.sourceBase)) fail('TASK_DELIVERY_REVIEW_SOURCE_CHANGED')
    await git('merge-base','--is-ancestor',item.sourceBase,commit)
    projects.push({ repository: item.repository, directory, commit, treeSha: await git('rev-parse','HEAD^{tree}'), pr, sourcePatch: await git('diff', '--no-ext-diff', '--no-textconv', item.sourceBase, commit) })
  }
  const primary = repositories.find(value => value.id === repository.id)
  const primaryName = primary?.githubRepository ?? primary?.remote?.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
  if (!names.has(primaryName)) fail('TASK_DELIVERY_REVIEW_REPOSITORY_MISMATCH')
  const evidence = []
  for (const item of input.evidence) {
    const path = await realpath(item.path)
    // Parent directory must occur in the authorized requirement; realpath prevents link escape.
    if (!authorized(path)) fail('TASK_DELIVERY_REVIEW_EVIDENCE_SCOPE_INVALID')
    const bytes = await readFile(path)
    if (hash(bytes) !== item.sha256) fail('TASK_DELIVERY_REVIEW_EVIDENCE_CHANGED')
    evidence.push({ path, sha256: item.sha256, description: item.description, bytes: bytes.length, content: bytes.length <= 131072 ? bytes.toString('utf8') : null })
  }
  if(input.acceptance && (!Array.isArray(input.acceptance.scenarioIds)||!input.acceptance.scenarioIds.length||new Set(input.acceptance.scenarioIds).size!==input.acceptance.scenarioIds.length||input.acceptance.scenarioIds.some(id=>typeof id!=='string'||!id.trim()))) fail('TASK_DELIVERY_REVIEW_ACCEPTANCE_INVALID')
  return { kind: 'verified-delivered-engineering-facts', taskId, runId: input.runId, projects, evidence, ...(input.acceptance?{acceptance:input.acceptance}:{}),
    verificationBoundary: 'Host verified candidate identity, Draft PR state and evidence bytes. Acceptance claims and applicability require original Owner judgment.',
    scope: { submitted: input.scope, deployed: false }, sourceInput: input }
}

export function validateOwnerCandidateAcceptance({decision,reviewRef,facts}) {
  const acceptance=decision.candidateAcceptance
  if(decision.action!=='wait'||!acceptance||!Array.isArray(acceptance.scenarioIds)||!acceptance.scenarioIds.length
    ||new Set(acceptance.scenarioIds).size!==acceptance.scenarioIds.length
    ||acceptance.scenarioIds.some(id=>!facts.acceptance?.scenarioIds?.includes(id))
    ||!Array.isArray(acceptance.evidenceRefs)||!acceptance.evidenceRefs.includes(reviewRef)
    ||acceptance.evidenceRefs.some(ref=>!decision.evidenceRefs?.includes(ref)))fail('TASK_OWNER_CANDIDATE_ACCEPTANCE_UNVERIFIED')
  return acceptance
}

/** Reuse current original-Owner accepted evidence, never manufacture engineering node outputs. */
export async function readOwnerAcceptedDeliveryBinding({store,taskId}) {
  const candidateBinding=await store.query({kind:'task.owner.candidate-acceptance',taskId})
  return {binding:candidateBinding ?? await store.query({kind:'task.owner.delivery-manifest',taskId,includeHistorical:true}),candidate:Boolean(candidateBinding)}
}

async function readAcceptedDeliveryFacts({taskId,store,artifacts,repositories,queryCommand}) {
  const {binding,candidate}=await readOwnerAcceptedDeliveryBinding({store,taskId})
  if(!binding?.ref)fail('UAT_OWNER_ACCEPTANCE_REQUIRED')
  const manifest=await artifacts.read(binding.ref)
  if(manifest.taskId!==taskId||manifest.source!=='original-owner-delivery-review'
    ||manifest.requirementRevision!==binding.requirementRevision||manifest.planRevision!==binding.planRevision)fail('UAT_OWNER_ACCEPTANCE_REQUIRED')
  if(candidate ? manifest.kind!=='task-candidate-acceptance'||manifest.version!==1||manifest.accepted!==true||manifest.businessCompleted!==false
      ||manifest.decision?.action!=='wait'||!manifest.scenarioIds?.length||!manifest.evidenceRefs?.includes(manifest.reviewRef)
    : manifest.complete!==true||manifest.businessValidation?.status!=='accepted'||!manifest.businessValidation.assessments?.length
      ||manifest.businessValidation.assessments.some(item=>item.status!=='satisfied'))fail('UAT_OWNER_ACCEPTANCE_REQUIRED')
  const facts=await artifacts.read(manifest.reviewRef),plan=await store.query({kind:'task.plan',taskId}),requirement=await artifacts.read(plan.task.requirementRef)
  if(facts.kind!=='verified-delivered-engineering-facts'||facts.taskId!==taskId||!facts.projects?.length||!facts.acceptance?.scenarioIds?.length)fail('UAT_OWNER_ACCEPTANCE_REQUIRED')
  const scenarioIds=candidate ? manifest.scenarioIds : facts.acceptance.scenarioIds
  if(candidate && (new Set(scenarioIds).size!==scenarioIds.length||scenarioIds.some(id=>!facts.acceptance.scenarioIds.includes(id))
    ||executionDigest(manifest.decision.candidateAcceptance)!==executionDigest({scenarioIds,evidenceRefs:manifest.evidenceRefs})))fail('UAT_OWNER_ACCEPTANCE_REQUIRED')
  const repository=repositories.find(item=>item.id===requirement.target?.repositoryId)
  const current=await verifyDeliveredEngineeringFacts({taskId,requirement,repository,repositories,input:facts.sourceInput,queryCommand,requireDraft:false,allowMerged:true})
  const identity=value=>({projects:value.projects.map(item=>({repository:item.repository,directory:item.directory,commit:item.commit,treeSha:item.treeSha,prNumber:item.pr.number,base:item.pr.baseRefName,head:item.pr.headRefName})),evidence:value.evidence.map(item=>({path:item.path,sha256:item.sha256})),acceptance:value.acceptance})
  if(executionDigest(identity(current))!==executionDigest(identity(facts)))fail('UAT_OWNER_EVIDENCE_CHANGED')
  return {binding,candidate,manifest,facts,current,scenarioIds,evidenceDigest:executionDigest(identity(current))}
}

export async function readAcceptedProjectDeliveryProof(options) {
  const {taskId,repository:repositoryName,headCommitSha,pullRequestNumber}=options
  const {binding,candidate,manifest,facts,current,scenarioIds,evidenceDigest}=await readAcceptedDeliveryFacts(options)
  const project=current.projects.find(item=>item.repository===repositoryName&&item.commit===headCommitSha&&item.pr.number===pullRequestNumber)
  if(!project||project.pr.state!=='OPEN'||project.pr.mergedAt)fail('UAT_OWNER_CANDIDATE_MISMATCH')
  return {taskId,runId:facts.runId,commitSha:project.commit,treeSha:project.treeSha,scenarioIds:[...scenarioIds],definitionVersion:candidate?'original-owner-candidate-v1':'original-owner-review-v1',manifestRef:binding.ref,reviewRef:manifest.reviewRef,evidenceDigest}
}

/** Current applicability of a real original Owner acceptance; never a new test or completion decision. */
export async function readAcceptedCandidateCompletionEvidence(options) {
  const binding=await options.store.query({kind:'task.owner.candidate-acceptance',taskId:options.taskId})
  if(!binding?.ref)return []
  const {candidate,manifest,facts,current,evidenceDigest}=await readAcceptedDeliveryFacts(options)
  if(!candidate)fail('UAT_OWNER_ACCEPTANCE_REQUIRED')
  const plan=await options.store.query({kind:'task.plan',taskId:options.taskId})
  const currentProjects=current.projects.map(project=>({repository:project.repository,directory:project.directory,
    commit:project.commit,treeSha:project.treeSha,pr:project.pr}))
  const supplementaryReviews=[]
  const review=await options.store.query({kind:'task.owner.delivery-review-evidence',taskId:options.taskId})
  if(review?.payloadRef && review.payloadRef!==manifest.reviewRef){
    const supplemental=await options.artifacts.read(review.payloadRef)
    const stage=plan.stages?.find(item=>item.runId===supplemental?.runId)
    if(supplemental?.kind!=='verified-delivered-engineering-facts'||supplemental.taskId!==options.taskId
      || !stage || stage.status!=='succeeded' || !stage.outputRef)fail('TASK_DELIVERY_REVIEW_PUBLICATION_UNVERIFIED')
    const requirement=await options.artifacts.read(plan.task.requirementRef)
    const repository=options.repositories.find(item=>item.id===requirement.target?.repositoryId)
    const verified=await verifyDeliveredEngineeringFacts({taskId:options.taskId,requirement,repository,
      repositories:options.repositories,input:supplemental.sourceInput,queryCommand:options.queryCommand,requireDraft:false,allowMerged:true})
    if(verified.projects.length!==current.projects.length || verified.projects.some(project=>!current.projects.some(item=>
      item.repository===project.repository && item.commit===project.commit && item.treeSha===project.treeSha
      && item.pr.number===project.pr.number)))fail('TASK_DELIVERY_REVIEW_CANDIDATE_MISMATCH')
    if(executionDigest(verified.evidence.map(item=>({path:item.path,sha256:item.sha256})))
      !==executionDigest(supplemental.evidence.map(item=>({path:item.path,sha256:item.sha256}))))fail('TASK_DELIVERY_REVIEW_EVIDENCE_CHANGED')
    supplementaryReviews.push({reviewRef:review.payloadRef,runId:supplemental.runId,stageId:stage.stageId,
      stageOutputRef:stage.outputRef,requirementRevision:review.requirementRevision,
      verificationBoundary:'Host verified registered review, current candidate and evidence bytes; runtime claims require original Owner semantic judgment.',
      evidence:verified.evidence,projects:verified.projects.map(project=>({repository:project.repository,commit:project.commit,treeSha:project.treeSha,pr:project.pr}))})
  }
  const reviewedFacts={kind:facts.kind,taskId:facts.taskId,runId:facts.runId,scope:facts.scope,
    verificationBoundary:facts.verificationBoundary,acceptance:facts.acceptance,evidence:facts.evidence,projects:currentProjects,
    ...(supplementaryReviews.length?{supplementaryReviews}:{})}
  return [binding.ref,manifest.reviewRef].map(ref=>({kind:'original-owner-candidate',taskId:options.taskId,
    requirementRevision:plan.task.requirementRevision,evidenceRef:ref,artifactRef:ref,
    evidence:{...(ref===binding.ref?{acceptance:manifest}:{reviewedFacts}),currentProjects,evidenceDigest},
    ownerCandidate:{acceptanceRef:binding.ref,reviewRef:manifest.reviewRef,
      sourceRequirementRevision:manifest.requirementRevision,accepted:true,businessCompleted:false}}))
}
