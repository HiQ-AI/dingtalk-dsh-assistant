import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const target = '0.2.1-alpha.2';
const migrationEdges = new Set(['@deepseek-ai/dsh-session-format-v0-to-v1', '@deepseek-ai/dsh-session-format-v1-to-v2', '@deepseek-ai/dsh-session-format-v2-to-v3', '@deepseek-ai/dsh-session-format-v3-to-v4']);
const jsonlBackend = '@deepseek-ai/dsh-session-persistence-jsonl';
// Cordis的!!js仅作为不透明文本校验，不执行，也不重新序列化原patch。
const patchSchema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })]);
const loadPatch = text => yaml.load(text, { schema: patchSchema });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sections = ['dependencies', 'devDependencies', 'optionalDependencies'];
const fail = message => { throw new Error(message); };
const equal = isDeepStrictEqual;
const host = name => name.startsWith('@deepseek-ai/dsh');
const metadata = value => {
  const result = structuredClone(value);
  for (const section of sections) delete result[section];
  if (result.pnpm?.overrides) result.pnpm.overrides = Object.fromEntries(Object.entries(result.pnpm.overrides).filter(([name]) => !host(name)));
  return result;
};

export function localPackageInputs(manifest) {
  const entries = [...sections.flatMap(section => Object.entries(manifest[section] ?? {})), ...Object.entries(manifest.pnpm?.overrides ?? {})];
  return entries.filter(([, spec]) => typeof spec === 'string' && spec.startsWith('file:')).map(([name, spec]) => {
    const local = spec.slice(5);
    if (!path.isAbsolute(local) || !local.endsWith('.tgz') || !fs.statSync(local).isFile()) fail('LOCAL_PACKAGE_ABSOLUTE_TGZ_REQUIRED');
    return { name, path: local, sha256: hash(fs.readFileSync(local)) };
  });
}

function packedMigration(name, spec) {
  const file = spec.slice(5);
  if ((!migrationEdges.has(name) && name !== jsonlBackend) || !path.isAbsolute(file) || !file.endsWith('.tgz')) fail('LOCAL_HOST_OVERRIDE_FORBIDDEN');
  const beforeSha256 = hash(fs.readFileSync(file));
  const read = member => execFileSync('tar', ['-xOf', file, `package/${member}`], { maxBuffer: 16 * 1024 * 1024 });
  const meta = JSON.parse(read('package.json'));
  if (meta.name !== name || meta.version !== target) fail('MIGRATION_PACKAGE_IDENTITY_MISMATCH');
  const main = meta.main?.replace(/^\.\//, '');
  if (typeof main !== 'string' || main.includes('\\') || path.posix.isAbsolute(main) || path.win32.isAbsolute(main) || main.split('/').includes('..')) fail('MIGRATION_PACKAGE_MAIN_INVALID');
  const mainSha256 = hash(read(main));
  const workerSha256 = name === jsonlBackend ? hash(read('lib/worker.cjs')) : undefined;
  if (hash(fs.readFileSync(file)) !== beforeSha256) fail('MIGRATION_PACKAGE_CHANGED_DURING_INSPECTION');
  return { name, path: file, sha256: beforeSha256, version: meta.version, main, mainSha256, ...(workerSha256 === undefined ? {} : { worker: 'lib/worker.cjs', workerSha256 }) };
}

// 本工具只更新声明与追加patch；安装、锁和维护生命周期由既有部署脚本拥有。
export function upgrade({ profile, proposal, apply = false }) {
  if (!path.isAbsolute(profile) || !path.isAbsolute(proposal)) fail('ABSOLUTE_PATH_REQUIRED');
  const input = JSON.parse(fs.readFileSync(proposal, 'utf8'));
  const keys = ['schemaVersion', 'targetDshVersion', 'expectedPackageJsonSha256', 'expectedPatchSha256', 'packageJson', 'patchAppend'];
  if (!equal(Object.keys(input).sort(), keys.sort()) || input.schemaVersion !== 1 || input.targetDshVersion !== target) fail('PROPOSAL_SCHEMA_INVALID');
  for (const field of ['expectedPackageJsonSha256', 'expectedPatchSha256']) if (!/^[a-f\d]{64}$/i.test(input[field])) fail('EXPECTED_HASH_INVALID');
  const manifestPath = path.join(profile, 'package.json');
  const patchPath = path.join(profile, 'cordis.patch.yml');
  const originalManifest = fs.readFileSync(manifestPath);
  const originalPatch = fs.readFileSync(patchPath);
  if (hash(originalManifest) !== input.expectedPackageJsonSha256.toLowerCase() || hash(originalPatch) !== input.expectedPatchSha256.toLowerCase()) fail('PROFILE_CAS_MISMATCH');
  const current = JSON.parse(originalManifest);
  const next = input.packageJson;
  if (!next || Array.isArray(next) || !equal(metadata(current), metadata(next))) fail('MANIFEST_METADATA_OR_BUNDLES_CHANGED');
  for (const [name, spec] of Object.entries(next.pnpm?.overrides ?? {})) {
    if (host(name) && typeof spec === 'string' && spec.startsWith('file:')) packedMigration(name, spec);
    else if (host(name) && (spec !== target || name === '@deepseek-ai/dsh-invariants')) fail('OLD_HOST_OVERRIDE_FORBIDDEN');
  }
  if (typeof input.patchAppend !== 'string') fail('PATCH_APPEND_INVALID');
  const append = input.patchAppend;
  const oldEntries = loadPatch(originalPatch.toString('utf8')) ?? [];
  const extraEntries = loadPatch(append) ?? [];
  if (!Array.isArray(oldEntries) || !Array.isArray(extraEntries)) fail('PATCH_LIST_REQUIRED');
  const market = /(?:plugin-market|dsh-market|dshmarket|plugin-store)/i;
  if (market.test(JSON.stringify(next)) || market.test(JSON.stringify(extraEntries))) fail('MARKET_FORBIDDEN');
  for (const section of sections) {
    for (const [name, spec] of Object.entries(next[section] ?? {})) {
      if (typeof spec !== 'string') fail('DEPENDENCY_SPEC_INVALID');
      if (name.startsWith('@deepseek-ai/dsh') && (spec !== target || name === '@deepseek-ai/dsh-invariants')) fail('OLD_HOST_DEPENDENCY_FORBIDDEN');
      if (spec.startsWith('file:')) {
        const local = spec.slice(5);
        if (!path.isAbsolute(local) || !local.endsWith('.tgz') || !fs.statSync(local).isFile()) fail('LOCAL_PACKAGE_ABSOLUTE_TGZ_REQUIRED');
      }
    }
  }
  if (next.dependencies?.['@deepseek-ai/dsh'] !== target) fail('HOST_DEPENDENCY_REQUIRED');
  const newManifest = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  const separator = append && originalPatch.length && originalPatch.at(-1) !== 10 ? '\n' : '';
  const newPatch = Buffer.concat([originalPatch, Buffer.from(separator + append)]);
  if (!Array.isArray(loadPatch(newPatch.toString('utf8')))) fail('COMBINED_PATCH_INVALID');
  const result = { mode: apply ? 'apply' : 'check', writes: apply ? 2 : 0, targetDshVersion: target,
    beforePackageJsonSha256: hash(originalManifest), beforePatchSha256: hash(originalPatch),
    packageJsonSha256: hash(newManifest), patchSha256: hash(newPatch), localPackages: localPackageInputs(next),
    migrationPackages: Object.entries(next.pnpm?.overrides ?? {}).filter(([name, spec]) => host(name) && typeof spec === 'string' && spec.startsWith('file:')).map(([name, spec]) => packedMigration(name, spec)) };
  for (const packed of result.migrationPackages) if (!result.localPackages.some(local => local.name === packed.name && local.path === packed.path && local.sha256 === packed.sha256)) fail('MIGRATION_PACKAGE_CHANGED_DURING_INSPECTION');
  if (apply) {
    // 两文件所有语义验证完成后再次CAS，失败不写；调用者必须持续持有离线owner锁。
    if (hash(fs.readFileSync(manifestPath)) !== hash(originalManifest) || hash(fs.readFileSync(patchPath)) !== hash(originalPatch)) fail('PROFILE_CAS_MISMATCH');
    for (const local of result.localPackages) if (hash(fs.readFileSync(local.path)) !== local.sha256) fail('LOCAL_PACKAGE_CHANGED_BEFORE_APPLY');
    fs.writeFileSync(manifestPath, newManifest);
    fs.writeFileSync(patchPath, newPatch);
    if (hash(fs.readFileSync(manifestPath)) !== result.packageJsonSha256 || hash(fs.readFileSync(patchPath)) !== result.patchSha256) fail('APPLY_READBACK_MISMATCH');
  }
  return result;
}

export function verify({ profile, proposal }) {
  if (!path.isAbsolute(profile) || !path.isAbsolute(proposal)) fail('ABSOLUTE_PATH_REQUIRED');
  const input = JSON.parse(fs.readFileSync(proposal, 'utf8'));
  if (input.schemaVersion !== 1 || input.targetDshVersion !== target) fail('PROPOSAL_SCHEMA_INVALID');
  const manifest = fs.readFileSync(path.join(profile, 'package.json'));
  if (!equal(JSON.parse(manifest), input.packageJson)) fail('INSTALLED_MANIFEST_CONTENT_MISMATCH');
  const overrides = Object.entries(input.packageJson.pnpm?.overrides ?? {}).filter(([name, spec]) => host(name) && typeof spec === 'string' && spec.startsWith('file:'));
  const resolveFrom = (consumer, name) => fs.realpathSync(createRequire(consumer).resolve(`${name}/package.json`));
  const baseManifest = overrides.length ? resolveFrom(path.join(profile, 'package.json'), '@deepseek-ai/dsh-base') : undefined;
  const jsonlManifest = baseManifest ? resolveFrom(baseManifest, jsonlBackend) : undefined;
  const catalogManifest = overrides.some(([name]) => migrationEdges.has(name)) ? resolveFrom(jsonlManifest, '@deepseek-ai/dsh-session-format-catalog') : undefined;
  const migrationPackages = overrides.map(([name, spec]) => {
    const packed = packedMigration(name, spec);
    const installedManifest = name === jsonlBackend ? jsonlManifest : resolveFrom(catalogManifest, name);
    const meta = JSON.parse(fs.readFileSync(installedManifest));
    if (meta.name !== name || meta.version !== target || meta.main?.replace(/^\.\//, '') !== packed.main) fail('INSTALLED_MIGRATION_IDENTITY_MISMATCH');
    const actualMainSha256 = hash(fs.readFileSync(path.join(path.dirname(installedManifest), packed.main)));
    if (actualMainSha256 !== packed.mainSha256) fail('INSTALLED_MIGRATION_BYTES_MISMATCH');
    const actualWorkerSha256 = packed.worker === undefined ? undefined : hash(fs.readFileSync(path.join(path.dirname(installedManifest), packed.worker)));
    if (actualWorkerSha256 !== packed.workerSha256) fail('INSTALLED_MIGRATION_WORKER_BYTES_MISMATCH');
    return { ...packed, installedManifest, actualMainSha256, ...(actualWorkerSha256 === undefined ? {} : { actualWorkerSha256, installedWorkerByteVerified: true }), installedByteVerified: true };
  });
  return { mode: 'verify', writes: 0, packageJsonSha256: hash(manifest), patchSha256: hash(fs.readFileSync(path.join(profile, 'cordis.patch.yml'))), migrationPackages, localPackages: localPackageInputs(input.packageJson) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 5 || !['--check', '--apply', '--verify'].includes(args[0]) || args[1] !== '--profile' || args[3] !== '--proposal') fail('USAGE: --check|--apply|--verify --profile absolute-directory --proposal absolute-file');
    const options = { apply: args[0] === '--apply', profile: args[2], proposal: args[4] };
    console.log(JSON.stringify(args[0] === '--verify' ? verify(options) : upgrade(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
