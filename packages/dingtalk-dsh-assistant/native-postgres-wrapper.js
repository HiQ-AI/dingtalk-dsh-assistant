import { win32 } from 'node:path'

const safePath = value => typeof value === 'string' && /^[A-Za-z]:[\\/]/u.test(value) && !/[\r\n'";&|<>`$]/u.test(value)
export const postgresWrapperSchema = { type: 'object', properties: {
 scriptSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, historicalEvidenceRef: { type: 'string', minLength: 1, maxLength: 2000 },
 pgBin: { type: 'string', minLength: 1 }, port: { type: 'integer', minimum: 1, maximum: 65535 }, ownerText: { type: 'string', minLength: 1, maxLength: 300 },
}, required: ['scriptSha256', 'historicalEvidenceRef', 'pgBin', 'port', 'ownerText'], additionalProperties: false }

// Only parse a literal pwsh -File invocation, never PowerShell expressions. The
// reviewed historical hash is checked against the file by the native read probe.
export function postgresWrapperScope(command, evidence, binding, workspaceRoot) {
 if (typeof command !== 'string' || /[\r\n;|<>`$]/u.test(command) || !evidence || !safePath(workspaceRoot)
  || Object.keys(evidence).some(key => !Object.hasOwn(postgresWrapperSchema.properties, key))
  || !/^[a-f0-9]{64}$/u.test(evidence.scriptSha256 ?? '') || !evidence.historicalEvidenceRef?.trim()
  || evidence.historicalEvidenceRef.length > 2000 || !safePath(evidence.pgBin)
  || !Number.isSafeInteger(evidence.port) || evidence.port < 1 || evidence.port > 65535
  || typeof evidence.ownerText !== 'string' || !evidence.ownerText || evidence.ownerText.length > 300 || /['"\r\n`$]/u.test(evidence.ownerText)
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(binding.taskId)) return null
 const tokens = command.trim().match(/'[^']*'|"[^"]*"|[^\s]+/gu)?.map(token => /^['"]/u.test(token) ? token.slice(1, -1) : token) ?? []
 if (tokens[0] === '&') tokens.shift()
 if (!/^(?:pwsh(?:\.exe)?|[A-Za-z]:[\\/].*[\\/]pwsh\.exe)$/iu.test(tokens.shift() ?? '')) return null
 while (/^-(?:NoProfile|NonInteractive|NoLogo)$/iu.test(tokens[0] ?? '')) tokens.shift()
 if (tokens.shift()?.toLowerCase() !== '-file') return null
 const script = tokens.shift()
 if (!safePath(script) || win32.basename(script).toLowerCase() !== 'run-postgres.ps1'
  || tokens.length !== 2 || tokens[0].toLowerCase() !== '-action' || tokens[1].toLowerCase() !== 'serve') return null
 const taskDirectory = win32.join(workspaceRoot, 'tasks', binding.taskId), relative = win32.relative(taskDirectory, script)
 if (!relative || relative.startsWith('..') || win32.isAbsolute(relative)) return null
 const root = win32.join(win32.dirname(script), 'postgres')
 return { kind: 'local-postgres', executable: win32.join(evidence.pgBin, 'postgres.exe'), directory: win32.join(root, 'data'), port: evidence.port,
  wrapper: { script: win32.normalize(script), taskDirectory, ...evidence, ownerFile: win32.join(root, 'owner.txt') } }
}

export function referencesIsolatedPostgres(command, scope, taskDirectory) {
 const text = command.replaceAll('/', '\\').toLowerCase()
 if ([scope.directory, scope.wrapper?.script].filter(Boolean).some(path => text.includes(path.toLowerCase()))) return true
 if (!scope.wrapper || !safePath(taskDirectory)) return false
 // Literal relative invocation, call operator and dot-sourcing resolve against
 // this execution's task cwd too; changing the shell spelling is not permission.
 const paths = command.matchAll(/(?:^|[\s&(])(?:'([^']+\.ps1)'|"([^"]+\.ps1)"|([^\s;&|()]+\.ps1))(?=[\s)]|$)/giu)
 return [...paths].some(match => win32.resolve(taskDirectory, match[1] ?? match[2] ?? match[3]).toLowerCase() === scope.wrapper.script.toLowerCase())
}

// AST inspection only: do not dot-source or invoke the retained wrapper. In
// particular, its identity/prepare/cleanup branches may write to the database.
export const postgresWrapperInspection = String.raw`
function Get-PgSyntax([string]$Text) {
 $tokens = $null; $errors = $null
 $null = [Management.Automation.Language.Parser]::ParseInput($Text, [ref]$tokens, [ref]$errors)
 if ($errors.Count) { throw 'PG_WRAPPER_SYNTAX' }
 (@($tokens | Where-Object { $_.Kind -notin @('Comment','NewLine','EndOfInput') } | ForEach-Object { $_.Text }) -join ' ')
}
function Assert-PgStatement($Actual, [string]$Expected) {
 if ((Get-PgSyntax $Actual.Extent.Text) -cne (Get-PgSyntax $Expected)) { throw 'PG_WRAPPER_LAUNCH_UNSUPPORTED' }
}
function Assert-PgServeScript([string]$Text, $Scope) {
 $tokens = $null; $errors = $null
 $ast = [Management.Automation.Language.Parser]::ParseInput($Text, [ref]$tokens, [ref]$errors)
 if ($errors.Count -or $ast.BeginBlock -or $ast.ProcessBlock -or $ast.CleanBlock -or $ast.DynamicParamBlock -or $ast.UsingStatements.Count -or $ast.EndBlock.Traps.Count -or $ast.ScriptRequirements) { throw 'PG_WRAPPER_SCRIPT_UNSUPPORTED' }
 Assert-PgStatement $ast.ParamBlock 'param([Parameter(Mandatory = $true)][ValidateSet(''check'', ''prepare'', ''serve'', ''identity'', ''cleanup'')][string]$Action)'
 $expected = @(
  '$ErrorActionPreference = ''Stop''',
  ('$pgBin = ''' + $Scope.wrapper.pgBin + ''''),
  '$root = Join-Path $PSScriptRoot ''postgres''',
  '$data = Join-Path $root ''data''',
  '$marker = Join-Path $root ''owner.txt''',
  ('$ownerText = ''' + $Scope.wrapper.ownerText + ''''),
  ('$portNumber = ' + $Scope.port)
 )
 $statements = @($ast.EndBlock.Statements)
 if ($statements.Count -lt 12) { throw 'PG_WRAPPER_LAUNCH_MISSING' }
 for ($n = 0; $n -lt $expected.Count; $n++) { Assert-PgStatement $statements[$n] $expected[$n] }
 Assert-PgStatement $statements[7] 'foreach ($tool in @(''initdb.exe'', ''postgres.exe'', ''psql.exe'', ''pg_ctl.exe'')) { if (-not (Test-Path -LiteralPath (Join-Path $pgBin $tool))) { throw "missing $tool" } }'
 # Only skip branches that cannot execute with the original literal Action=serve.
 foreach ($n in @(8,9)) {
  $branch = $statements[$n]; $action = @('check','prepare')[$n - 8]
  if ($branch -isnot [Management.Automation.Language.IfStatementAst] -or $branch.Clauses.Count -ne 1 -or $branch.ElseClause) { throw 'PG_WRAPPER_BRANCH' }
  Assert-PgStatement $branch.Clauses[0].Item1 ('$Action -eq ''' + $action + '''')
 }
 Assert-PgStatement $statements[10] 'if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $ownerText) { throw ''Ownership marker mismatch; no process action permitted'' }'
 Assert-PgStatement $statements[11] 'if ($Action -eq ''serve'') { & (Join-Path $pgBin ''postgres.exe'') -D $data -h 127.0.0.1 -p $portNumber -c ''logging_collector=off''; exit $LASTEXITCODE }'.Replace('; ', [Environment]::NewLine)
}
function Assert-PgRegularPath([string]$Path) {
 $entry = Get-Item -LiteralPath $Path -ErrorAction Stop
 if ($entry.PSIsContainer) { throw 'PG_EVIDENCE_NOT_FILE' }
 while ($entry) {
  if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PG_EVIDENCE_REPARSE_POINT' }
  $parent = Split-Path -LiteralPath $entry.FullName
  if (!$parent -or $parent -eq $entry.FullName) { break }
  $entry = Get-Item -LiteralPath $parent -ErrorAction Stop
 }
}
function Assert-PgWrapperEvidence($Scope) {
 $w = $Scope.wrapper
 foreach ($file in @($w.script, $w.ownerFile, (Join-Path $Scope.directory 'postmaster.pid'), (Join-Path $Scope.directory 'postmaster.opts'), (Join-Path $Scope.directory 'postgresql.conf'), (Join-Path $Scope.directory 'postgresql.auto.conf'))) { Assert-PgRegularPath $file }
 if ((Get-FileHash -LiteralPath $w.script -Algorithm SHA256).Hash.ToLowerInvariant() -ne $w.scriptSha256) { throw 'PG_WRAPPER_HASH_MISMATCH' }
 Assert-PgServeScript ([IO.File]::ReadAllText($w.script)) $Scope
 if ([IO.File]::ReadAllText($w.ownerFile).Trim() -cne $w.ownerText) { throw 'PG_OWNER_MISMATCH' }
 $opts = [IO.File]::ReadAllText((Join-Path $Scope.directory 'postmaster.opts')).Trim()
 # PostgreSQL writes quoted argv here. Compare argv, not harmless option order.
 $argv = @([regex]::Matches($opts, '"([^"\r\n]*)"|([^\s"]+)') | ForEach-Object { if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value } })
 if ($argv.Count -ne 9 -or $argv[0].Replace('/','\') -ine $Scope.executable.Replace('/','\')) { throw 'PG_OPTS_MISMATCH' }
 $seen = @{}
 for ($n = 1; $n -lt $argv.Count; $n += 2) { if ($seen.ContainsKey($argv[$n])) { throw 'PG_OPTS_DUPLICATE' }; $seen[$argv[$n]] = $argv[$n + 1] }
 if ($seen.Count -ne 4 -or !$seen.ContainsKey('-D') -or $seen['-D'].Replace('/','\') -ine $Scope.directory.Replace('/','\') -or $seen['-h'] -cne '127.0.0.1' -or $seen['-p'] -ne [string]$Scope.port -or $seen['-c'] -cne 'logging_collector=off') { throw 'PG_OPTS_MISMATCH' }
 foreach ($name in @('postgresql.conf','postgresql.auto.conf')) {
  foreach ($line in [IO.File]::ReadAllLines((Join-Path $Scope.directory $name))) {
   if ($line -match '^\s*(?:include(?:_if_exists|_dir)?\b|(?:shared|session|local)_preload_libraries\b|data_directory\b|hba_file\b|ident_file\b|external_pid_file\b|archive_command\b|restore_command\b|archive_library\b)' -or ($name -eq 'postgresql.auto.conf' -and $line -match '^\s*[^#\s]')) { throw 'PG_EXTERNAL_DEPENDENCY_UNREVIEWED' }
  }
 }
}
`
