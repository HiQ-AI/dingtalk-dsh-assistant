import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, cpSync, existsSync } from 'node:fs'
import { resolve, join, dirname, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { Script } from 'node:vm'

const name = '@deepseek-ai/dsh-sandbox-policy'
const version = '0.2.1-rc.2.artifact.2'
const baseHash = '772ca58f0f786d6cb4d839deb621634c31097c13228d81b14e3f3153d0524924'
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw new Error(`ARTIFACT_POLICY_${code}`) }
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const replace = (source, before, after) => {
  if (source.split(before).length !== 2) fail('SOURCE_CONTRACT_CHANGED')
  return source.replace(before, after)
}

export function artifactPolicySource(original) {
  if (hash(original) !== baseHash) fail('SOURCE_HASH')
  let code = original.toString('utf8')
  code = replace(code, 'import { isAbsolute } from "node:path";',
    'import { isAbsolute, resolve, dirname, basename, relative } from "node:path";\nimport { lstatSync, realpathSync } from "node:fs";')
  code = replace(code, 'var SandboxPolicyService = class extends Service {', `function checkedArtifactBinding(value) {
  if (!value || typeof value.ownerId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.ownerId)
    || !isAbsolute(value.artifactRoot ?? "") || !isAbsolute(value.sessionCwd ?? ""))
    throw new Error("ARTIFACT_POLICY_BINDING_INVALID");
  const root = resolve(value.artifactRoot);
  if (root !== value.artifactRoot || basename(root) !== "outputs" || basename(dirname(root)) !== value.ownerId
    || basename(dirname(dirname(root))) !== "tasks") throw new Error("ARTIFACT_POLICY_ROOT_INVALID");
  let current = root;
  for (;;) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("ARTIFACT_POLICY_ROOT_LINK");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (relative(root, realpathSync(root)) !== "") throw new Error("ARTIFACT_POLICY_ROOT_LINK");
  return { ownerId: value.ownerId, artifactRoot: root, sessionCwd: value.sessionCwd };
}
var SandboxPolicyService = class extends Service {`)
  code = replace(code, '\t\tctx.inject(["systemPrompt"], (scope) => {', `\t\tctx.sessionProjections.register({
      key: "sandboxArtifactRoot", stateVersion: 1,
      stateSchema: z.strictObject({ ownerId: z.string(), artifactRoot: z.string(), sessionCwd: z.string() }).nullable(),
      init: () => null,
      apply: (state, event) => event.type === "sandbox/mode" && event.data.artifactRoot ? event.data.artifactRoot : state
    });
\t\tctx.inject(["systemPrompt"], (scope) => {`)
  code = replace(code, '\t\tconst { session } = request;\n\t\treturn {', `\t\tconst { session } = request;
    const binding = session === void 0 ? null : this.ctx.sessionProjections.stateOf(session, "sandboxArtifactRoot");
    if (binding) {
      checkedArtifactBinding(binding);
      if (session.header.cwd !== binding.sessionCwd) throw new Error("ARTIFACT_POLICY_SESSION_CHANGED");
      const effectiveMode = request.mode ?? this.overrideOf(session) ?? this.defaultMode;
      if (!["read-only", "workspace-write"].includes(effectiveMode)) throw new Error("ARTIFACT_POLICY_MODE_REQUIRED");
    }
\t\treturn {`)
  code = replace(code, 'workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),',
    'workspaceRoot: binding?.artifactRoot ?? resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),')
  code = replace(code, '\toverrideOf(session) {', `  /** Bind one trusted team artifact boundary without rewriting immutable session identity. */
  bindArtifactRoot(session, value) {
    const binding = checkedArtifactBinding({ ...value, sessionCwd: session.header.cwd });
    const previous = this.ctx.sessionProjections.stateOf(session, "sandboxArtifactRoot");
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(binding)) throw new Error("ARTIFACT_POLICY_BINDING_CHANGED");
      return previous;
    }
    session.append("sandbox/mode", { mode: this.overrideOf(session) ?? this.defaultMode, artifactRoot: binding });
    return binding;
  }
\toverrideOf(session) {`)
  new Script(code.replace(/^import .*;$/gm, '').replace(/^export .*;$/gm, ''), { filename: 'sandbox-artifact-policy.js' })
  return code
}

export function buildArtifactPolicy(sourceDirectory, destination) {
  if (!isAbsolute(sourceDirectory) || !isAbsolute(destination) || existsSync(destination)) fail('BUILD_PATH')
  const manifest = JSON.parse(readFileSync(join(sourceDirectory, 'package.json'), 'utf8'))
  if (manifest.name !== name || manifest.version !== '0.2.1-rc.2') fail('SOURCE_IDENTITY')
  const code = artifactPolicySource(readFileSync(join(sourceDirectory, 'lib/index.js')))
  mkdirSync(destination, { recursive: true })
  for (const part of ['lib', 'locale']) if (existsSync(join(sourceDirectory, part))) cpSync(join(sourceDirectory, part), join(destination, part), { recursive: true })
  const meta = { ...manifest, version, dsh: { localPatch: 'trusted-team-artifact-root-v1', originalVersion: manifest.version, originalEntrySha256: baseHash } }
  writeFileSync(join(destination, 'package.json'), JSON.stringify(meta, null, 2) + '\n')
  writeFileSync(join(destination, 'lib/index.js'), code)
  const types = join(destination, 'lib/types/index.d.ts')
  if (existsSync(types)) writeFileSync(types, replace(readFileSync(types, 'utf8'), '    overrideOf(session: Session): SandboxMode | undefined;',
    '    bindArtifactRoot(session: Session, binding: { ownerId: string; artifactRoot: string }): { ownerId: string; artifactRoot: string; sessionCwd: string };\n    overrideOf(session: Session): SandboxMode | undefined;'))
  return { name, version, destination, entrySha256: hash(Buffer.from(code)), originalEntrySha256: baseHash }
}

function proposalInputs(profile, proposal) {
  if (!isAbsolute(profile) || !isAbsolute(proposal)) fail('ABSOLUTE_PATH_REQUIRED')
  const input = JSON.parse(readFileSync(proposal, 'utf8'))
  if (input.schemaVersion !== 1 || input.name !== name || input.version !== version || !sha(input.expectedManifestSha256)
    || !isAbsolute(input.packagePath ?? '') || !sha(input.packageSha256) || !sha(input.entrySha256)) fail('PROPOSAL_INVALID')
  if (hash(readFileSync(input.packagePath)) !== input.packageSha256) fail('PACKAGE_HASH')
  const members = execFileSync('tar', ['-tf', input.packagePath], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)
  const entry = path => {
    if (members.filter(value => value === `package/${path}`).length !== 1) fail('PACKAGE_MEMBER')
    return execFileSync('tar', ['-xOf', input.packagePath, `package/${path}`], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  }
  const meta = JSON.parse(entry('package.json'))
  if (meta.name !== name || meta.version !== version || meta.dsh?.originalEntrySha256 !== baseHash
    || hash(entry('lib/index.js')) !== input.entrySha256) fail('PACKED_IDENTITY')
  return input
}

export function upgradeArtifactPolicy({ profile, proposal, mode = 'check' }) {
  if (!['check', 'apply', 'verify'].includes(mode)) fail('MODE')
  const input = proposalInputs(profile, proposal), manifestPath = join(profile, 'package.json')
  const original = readFileSync(manifestPath), manifest = JSON.parse(original)
  const spec = `file:${input.packagePath.replaceAll('\\', '/')}`
  if (mode === 'verify') {
    if (manifest.pnpm?.overrides?.[name] !== spec || manifest.dependencies?.[name] !== spec) fail('OVERRIDE_MISMATCH')
    const rootRequire = createRequire(manifestPath), baseEntry = rootRequire.resolve('@deepseek-ai/dsh-base')
    const policyEntry = createRequire(baseEntry).resolve(name)
    const installed = JSON.parse(readFileSync(join(dirname(policyEntry), '../package.json'), 'utf8'))
    if (installed.name !== name || installed.version !== version || hash(readFileSync(policyEntry)) !== input.entrySha256) fail('INSTALLED_IDENTITY')
    return { mode, writes: 0, baseEntry, policyEntry, version, entrySha256: input.entrySha256, manifestSha256: hash(original) }
  }
  if (hash(original) !== input.expectedManifestSha256) fail('MANIFEST_CAS')
  const next = structuredClone(manifest)
  next.dependencies = { ...next.dependencies, [name]: spec }
  next.pnpm = { ...next.pnpm, overrides: { ...next.pnpm?.overrides, [name]: spec } }
  const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n')
  if (mode === 'apply') {
    if (hash(readFileSync(manifestPath)) !== input.expectedManifestSha256) fail('MANIFEST_CAS')
    const pending = `${manifestPath}.artifact-policy-${process.pid}.tmp`
    try {
      writeFileSync(pending, bytes, { flag: 'wx' })
      if (hash(readFileSync(manifestPath)) !== input.expectedManifestSha256) fail('MANIFEST_CAS')
      renameSync(pending, manifestPath)
    } finally { try { unlinkSync(pending) } catch (error) { if (error.code !== 'ENOENT') throw error } }
    if (hash(readFileSync(manifestPath)) !== hash(bytes)) fail('WRITE_READBACK')
  }
  return { mode, writes: mode === 'apply' ? 1 : 0, previousManifestSha256: hash(original), nextManifestSha256: hash(bytes), name, version }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, a, b] = process.argv.slice(2)
  console.log(JSON.stringify(mode === 'build' ? buildArtifactPolicy(a, b) : upgradeArtifactPolicy({ mode, profile: a, proposal: b })))
}
