import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upgrade, verify, localPackageInputs } from './apply-host-upgrade.mjs';

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-upgrade-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const original = { private: true, dsh: { bundles: ['keep-existing'] }, dependencies: { '@deepseek-ai/dsh': '0.1.2-rc.1' } };
  const manifest = JSON.stringify(original);
  const patch = '# secret: keep verbatim\r\n- id: old\r\n  config:\r\n    token: unchanged\r\n';
  fs.writeFileSync(path.join(profile, 'package.json'), manifest);
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), patch);
  const value = { schemaVersion: 1, targetDshVersion: '0.2.1-alpha.2', expectedPackageJsonSha256: sha(manifest), expectedPatchSha256: sha(patch),
    packageJson: { ...original, dependencies: { '@deepseek-ai/dsh': '0.2.1-alpha.2' } }, patchAppend: '- id: preset-standard\n  config:\n    plugins: []\n' };
  const proposal = path.join(profile, 'proposal.json');
  const save = () => fs.writeFileSync(proposal, JSON.stringify(value));
  save();
  return { profile, proposal, value, save, manifest, patch };
}
test('check performs zero writes; apply preserves original patch bytes and binds expected hashes', t => {
  const f = fixture(t);
  const check = upgrade(f);
  assert.equal(check.writes, 0);
  assert.equal(fs.readFileSync(path.join(f.profile, 'package.json'), 'utf8'), f.manifest);
  assert.equal(fs.readFileSync(path.join(f.profile, 'cordis.patch.yml'), 'utf8'), f.patch);
  const applied = upgrade({ ...f, apply: true });
  assert.equal(applied.patchSha256, check.patchSha256);
  assert.equal(applied.packageJsonSha256, check.packageJsonSha256);
  assert.equal(fs.readFileSync(path.join(f.profile, 'cordis.patch.yml'), 'utf8'), f.patch + f.value.patchAppend);
});
for (const file of ['package.json', 'cordis.patch.yml']) test(`CAS rejects ${file} drift before either write`, t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.profile, file), ' ');
  const before = fs.readFileSync(path.join(f.profile, 'package.json'));
  assert.throws(() => upgrade({ ...f, apply: true }), /PROFILE_CAS_MISMATCH/);
  assert.deepEqual(fs.readFileSync(path.join(f.profile, 'package.json')), before);
});
for (const [name, spec, pattern] of [['@zzusp/dsh-plugin-market', '1.0.0', /MARKET_FORBIDDEN/], ['dshmarket', '1.48.0', /MARKET_FORBIDDEN/], ['@deepseek-ai/dsh-session', '0.1.2-rc.1', /OLD_HOST_DEPENDENCY_FORBIDDEN/]]) test(`rejects forbidden dependency ${name}`, t => {
  const f = fixture(t); f.value.packageJson.dependencies[name] = spec; f.save();
  assert.throws(() => upgrade({ ...f, apply: true }), pattern);
  assert.equal(fs.readFileSync(path.join(f.profile, 'package.json'), 'utf8'), f.manifest);
});
test('existing bundle list cannot change', t => {
  const f = fixture(t); f.value.packageJson.dsh = { bundles: [] }; f.save();
  assert.throws(() => upgrade(f), /MANIFEST_METADATA_OR_BUNDLES_CHANGED/);
});
function withOverrides(f) {
  const manifest = JSON.parse(f.manifest);
  manifest.pnpm = { overrides: { '@deepseek-ai/dsh-llm-pi-ai': 'file:D:/old-native-stop.tgz', 'other-package': '1.0.0' } };
  fs.writeFileSync(path.join(f.profile, 'package.json'), JSON.stringify(manifest));
  f.value.expectedPackageJsonSha256 = sha(JSON.stringify(manifest));
  f.value.packageJson.pnpm = structuredClone(manifest.pnpm);
}
test('old host override can be removed while non-host overrides stay intact', t => {
  const f = fixture(t); withOverrides(f);
  delete f.value.packageJson.pnpm.overrides['@deepseek-ai/dsh-llm-pi-ai']; f.save();
  assert.equal(upgrade(f).writes, 0);
});
test('retaining old host override is rejected', t => {
  const f = fixture(t); withOverrides(f); f.save();
  assert.throws(() => upgrade(f), /LOCAL_HOST_OVERRIDE_FORBIDDEN/);
});
test('non-host override cannot change', t => {
  const f = fixture(t); withOverrides(f);
  delete f.value.packageJson.pnpm.overrides['@deepseek-ai/dsh-llm-pi-ai'];
  f.value.packageJson.pnpm.overrides['other-package'] = '2.0.0'; f.save();
  assert.throws(() => upgrade(f), /MANIFEST_METADATA_OR_BUNDLES_CHANGED/);
});
test('verify accepts native JSON formatting but rejects content changes', t => {
  const f = fixture(t); upgrade({ ...f, apply: true });
  const reordered = { dependencies: f.value.packageJson.dependencies, dsh: f.value.packageJson.dsh, private: true };
  const formatted = JSON.stringify(reordered, null, '\t');
  fs.writeFileSync(path.join(f.profile, 'package.json'), formatted);
  assert.equal(verify(f).packageJsonSha256, sha(formatted));
  reordered.dependencies['@deepseek-ai/dsh'] = '0.1.2-rc.1';
  fs.writeFileSync(path.join(f.profile, 'package.json'), JSON.stringify(reordered));
  assert.throws(() => verify(f), /INSTALLED_MANIFEST_CONTENT_MISMATCH/);
});
test('Cordis !!js original and appended expressions stay opaque and byte-preserved', t => {
  const f = fixture(t);
  const original = '# secret untouched\r\n- id: old\r\n  config:\r\n    value: !!js process.exit(99)\r\n';
  const appended = '- id: preset-standard\n  config:\n    tool: !!js function () { return "opaque" }\n';
  fs.writeFileSync(path.join(f.profile, 'cordis.patch.yml'), original);
  f.value.expectedPatchSha256 = sha(original); f.value.patchAppend = appended; f.save();
  assert.equal(upgrade(f).writes, 0);
  upgrade({ ...f, apply: true });
  assert.equal(fs.readFileSync(path.join(f.profile, 'cordis.patch.yml'), 'utf8'), original + appended);
});
test('local inputs include all dependency sections and overrides, bound to file hashes', t => {
  const f = fixture(t);
  const names = ['assistant', 'codex', 'convergent', 'bytebase'];
  const paths = names.map(name => path.join(f.profile, `${name}.tgz`));
  paths.forEach((file, index) => fs.writeFileSync(file, `fixture-${index}`));
  const manifest = { dependencies: { assistant: `file:${paths[0]}` }, devDependencies: { codex: `file:${paths[1]}` },
    optionalDependencies: { convergent: `file:${paths[2]}` }, pnpm: { overrides: { bytebase: `file:${paths[3]}` } } };
  const inputs = localPackageInputs(manifest);
  assert.deepEqual(inputs.map(value => value.path), paths);
  inputs.forEach((value, index) => assert.equal(value.sha256, sha(`fixture-${index}`)));
  fs.writeFileSync(paths[1], 'changed');
  assert.notEqual(localPackageInputs(manifest)[1].sha256, inputs[1].sha256);
});
function migrationFixture(t, { name = '@deepseek-ai/dsh-session-format-v0-to-v1', version = '0.2.1-alpha.2' } = {}) {
  const f = fixture(t);
  const source = path.join(f.profile, 'package');
  fs.mkdirSync(path.join(source, 'lib'), { recursive: true });
  const meta = { name, version, main: 'lib/index.js' };
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(source, 'lib/index.js'), 'export const owned = true;\n');
  if (name === '@deepseek-ai/dsh-session-persistence-jsonl') fs.writeFileSync(path.join(source, 'lib/worker.cjs'), 'module.exports = { ownedMigration: true };\n');
  const tarball = path.join(f.profile, 'migration.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', f.profile, 'package']);
  f.value.packageJson.pnpm = { overrides: { [['@deepseek-ai/dsh-session-format-v2-to-v3', '@deepseek-ai/dsh-session-format-v3-to-v4', '@deepseek-ai/dsh-session-persistence-jsonl'].includes(name) ? name : '@deepseek-ai/dsh-session-format-v0-to-v1']: `file:${tarball}` } };
  const old = JSON.parse(f.manifest); old.pnpm = { overrides: {} };
  fs.writeFileSync(path.join(f.profile, 'package.json'), JSON.stringify(old));
  f.value.expectedPackageJsonSha256 = sha(JSON.stringify(old)); f.save();
  // 模拟pnpm：root只链接base；每个真实consumer拥有自己的依赖链接。
  const store = path.join(f.profile, '.pnpm-store');
  const packageDirectory = (id, packageName) => {
    const directory = path.join(store, id, 'node_modules', packageName);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: packageName, version: '0.2.1-alpha.2', main: 'lib/index.js' }));
    return directory;
  };
  const link = (consumer, packageName, directory) => {
    const dependency = path.join(consumer, 'node_modules', packageName);
    fs.mkdirSync(path.dirname(dependency), { recursive: true }); fs.symlinkSync(directory, dependency, process.platform === 'win32' ? 'junction' : 'dir');
  };
  const base = packageDirectory('base', '@deepseek-ai/dsh-base');
  const jsonl = packageDirectory('jsonl', '@deepseek-ai/dsh-session-persistence-jsonl');
  const catalog = packageDirectory('catalog', '@deepseek-ai/dsh-session-format-catalog');
  link(f.profile, '@deepseek-ai/dsh-base', base); link(base, '@deepseek-ai/dsh-session-persistence-jsonl', jsonl); link(jsonl, '@deepseek-ai/dsh-session-format-catalog', catalog);
  const installed = name === '@deepseek-ai/dsh-session-persistence-jsonl' ? jsonl : packageDirectory('edge', name);
  if (installed !== jsonl) link(catalog, name, installed);
  return { ...f, source, tarball, meta, installed };
}
test('only approved migration edge tarball identities are allowed', t => {
  const f = migrationFixture(t);
  assert.equal(upgrade(f).migrationPackages[0].version, '0.2.1-alpha.2');
  delete f.value.packageJson.pnpm.overrides['@deepseek-ai/dsh-session-format-v0-to-v1'];
  f.value.packageJson.pnpm.overrides['@deepseek-ai/dsh-llm'] = `file:${f.tarball}`; f.save();
  assert.throws(() => upgrade(f), /LOCAL_HOST_OVERRIDE_FORBIDDEN/);
});
test('v2-to-v3 migration edge is allowed with exact metadata; unlisted host package is rejected', t => {
  const name = '@deepseek-ai/dsh-session-format-v2-to-v3';
  const f = migrationFixture(t, { name });
  assert.equal(upgrade(f).migrationPackages[0].name, name);
  delete f.value.packageJson.pnpm.overrides[name];
  f.value.packageJson.pnpm.overrides['@deepseek-ai/dsh-other-host'] = `file:${f.tarball}`; f.save();
  assert.throws(() => upgrade(f), /LOCAL_HOST_OVERRIDE_FORBIDDEN/);
});
test('v3-to-v4 approved edge requires exact identity and is byte verified', t => {
  const f = migrationFixture(t, { name: '@deepseek-ai/dsh-session-format-v3-to-v4' });
  assert.equal(upgrade(f).migrationPackages[0].name, f.meta.name);
  upgrade({ ...f, apply: true });
  const installed = f.installed;
  fs.mkdirSync(path.dirname(installed), { recursive: true }); fs.cpSync(f.source, installed, { recursive: true });
  assert.equal(verify(f).migrationPackages[0].installedByteVerified, true);
});
test('approved JSONL backend check is zero write and installed worker bytes must match packed closure', t => {
  const f = migrationFixture(t, { name: '@deepseek-ai/dsh-session-persistence-jsonl' });
  const before = fs.readFileSync(path.join(f.profile, 'package.json'));
  const check = upgrade(f);
  assert.equal(check.writes, 0); assert.deepEqual(fs.readFileSync(path.join(f.profile, 'package.json')), before);
  assert.ok(check.migrationPackages[0].workerSha256);
  upgrade({ ...f, apply: true });
  const installed = f.installed;
  fs.mkdirSync(path.dirname(installed), { recursive: true }); fs.cpSync(f.source, installed, { recursive: true });
  assert.equal(verify(f).migrationPackages[0].installedWorkerByteVerified, true);
  fs.appendFileSync(path.join(installed, 'lib/worker.cjs'), '// stale stock migration closure');
  assert.throws(() => verify(f), /INSTALLED_MIGRATION_WORKER_BYTES_MISMATCH/);
});
for (const mismatch of [{ name: '@deepseek-ai/dsh-other' }, { version: '0.1.2-rc.1' }]) test(`tarball rejects metadata mismatch ${JSON.stringify(mismatch)}`, t => {
  const f = migrationFixture(t, mismatch);
  assert.throws(() => upgrade(f), /MIGRATION_PACKAGE_IDENTITY_MISMATCH/);
});
test('pnpm consumer chain resolves edge without root link and rejects installed main tampering', t => {
  const f = migrationFixture(t); upgrade({ ...f, apply: true });
  assert.equal(fs.existsSync(path.join(f.profile, 'node_modules', f.meta.name)), false);
  assert.ok(fs.lstatSync(path.join(f.profile, 'node_modules', '@deepseek-ai/dsh-base')).isSymbolicLink());
  const installed = f.installed;
  fs.mkdirSync(path.dirname(installed), { recursive: true }); fs.cpSync(f.source, installed, { recursive: true });
  assert.equal(verify(f).migrationPackages[0].installedByteVerified, true);
  fs.appendFileSync(path.join(installed, 'lib/index.js'), '// tampered');
  assert.throws(() => verify(f), /INSTALLED_MIGRATION_BYTES_MISMATCH/);
});
test('tarball asset tampering changes frozen input fingerprint', t => {
  const f = migrationFixture(t); const original = upgrade(f).localPackages[0].sha256;
  fs.appendFileSync(f.tarball, 'different input bytes');
  assert.notEqual(localPackageInputs(f.value.packageJson)[0].sha256, original);
});
test('production PowerShell input hook verifies applied profile on Readback and Resume', t => {
  const f = fixture(t); upgrade({ ...f, apply: true });
  const deployPath = fileURLToPath(new URL('../../topic-context-completeness/scripts/deploy-owner-repair.ps1', import.meta.url));
  const script = fs.readFileSync(deployPath, 'utf8');
  const block = script.match(/if\(\$HostUpgradeProposal\)\{\r?\n \$hostUpgradeInputMode=[\s\S]*?\r?\n\}/)?.[0];
  assert.ok(block, 'actual deployment input hook located');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const helper = fileURLToPath(new URL('./apply-host-upgrade.mjs', import.meta.url));
  for (const mode of ['Readback', 'Resume']) {
    const command = `$ErrorActionPreference='Stop';$node=${quote(process.execPath)};$hostUpgradeTool=${quote(helper)};$profile=${quote(f.profile)};$HostUpgradeProposal=${quote(f.proposal)};$deploymentInputs=@();$${mode}=$true;${block};$hostUpgradeInputs|ConvertTo-Json -Compress`;
    const output = execFileSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).mode, 'verify');
    assert.equal(JSON.parse(output).writes, 0);
  }
  assert.throws(() => upgrade(f), /PROFILE_CAS_MISMATCH/);
});
