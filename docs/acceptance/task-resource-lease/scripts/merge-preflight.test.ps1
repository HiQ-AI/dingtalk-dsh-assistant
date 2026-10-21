[CmdletBinding()]
param(
    [string]$MockCase,
    [string]$HelperPath = 'D:\dsh_home\skills\uat-pr\scripts\read-github-mergeability.ps1'
)
$ErrorActionPreference = 'Stop'

if ($MockCase) {
    $global:mergePreflightTestReads = [Collections.Generic.List[string]]::new()
    $global:mergePreflightTestPullReads = 0
    function global:gh {
        param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
        if ($Arguments.Count -ne 4 -or $Arguments[0] -cne 'api' -or
            $Arguments[1] -cne '--method' -or $Arguments[2] -cne 'GET') { throw 'only_explicit_get_allowed' }
        $endpoint = $Arguments[3]
        $global:mergePreflightTestReads.Add($endpoint)
        $global:LASTEXITCODE = 0
        if ($MockCase -eq 'read_failure') { $global:LASTEXITCODE = 1; return }
        if ($MockCase -eq 'invalid_json') { return 'not JSON' }
        if ($endpoint -eq 'repos/example/project/pulls/7') {
            $global:mergePreflightTestPullReads++
            $pr = @{
                number = 7; state = 'open'; merged = $false; draft = $false
                head = @{ sha = ('a' * 40) }
                base = @{ ref = 'feature/uat2-base'; sha = ('b' * 40); repo = @{ full_name = 'example/project' } }
                mergeable = $true; mergeable_state = 'clean'
            }
            switch ($MockCase) {
                'unknown_then_true' { if ($global:mergePreflightTestPullReads -eq 1) { $pr.mergeable = $null; $pr.mergeable_state = 'unknown' } }
                'unknown_forever' { $pr.mergeable = $null; $pr.mergeable_state = 'unknown' }
                'unknown_state_true_boolean' { $pr.mergeable_state = 'unknown' }
                'unknown_then_head_drift' {
                    if ($global:mergePreflightTestPullReads -eq 1) { $pr.mergeable = $null; $pr.mergeable_state = 'unknown' }
                    else { $pr.head.sha = 'c' * 40 }
                }
                'false' { $pr.mergeable = $false; $pr.mergeable_state = 'dirty' }
                'head_drift' { $pr.head.sha = 'c' * 40 }
                'cached_pr_base_differs' { $pr.base.sha = 'c' * 40 }
                'wrong_branch' { $pr.base.ref = 'main' }
                'wrong_repository' { $pr.base.repo.full_name = 'example/other' }
                'wrong_pr' { $pr.number = 8 }
                'closed' { $pr.state = 'closed' }
                'merged' { $pr.merged = $true }
                'draft' { $pr.draft = $true }
                'missing_draft' { $pr.Remove('draft') }
                'blocked' { $pr.mergeable_state = 'blocked' }
                'behind' { $pr.mergeable_state = 'behind' }
                'string_true' { $pr.mergeable = 'true' }
                'unrecognized_state' { $pr.mergeable_state = 'new_state' }
                'unstable_checks_not_attested' { $pr.mergeable_state = 'unstable' }
            }
            return ($pr | ConvertTo-Json -Depth 5 -Compress)
        }
        if ($endpoint -eq 'repos/example/project/git/ref/heads/feature%2Fuat2-base') {
            $ref = @{ ref = 'refs/heads/feature/uat2-base'; object = @{ sha = ('b' * 40) } }
            if ($MockCase -eq 'live_base_drift') { $ref.object.sha = 'c' * 40 }
            return ($ref | ConvertTo-Json -Depth 3 -Compress)
        }
        throw 'unexpected_endpoint'
    }
    & pwsh -NoProfile -Command 'exit 17'
    $raw = & $HelperPath -Repository 'example/project' -PullRequest 7 -ExpectedHeadSha ('a' * 40) `
        -ExpectedBaseBranch 'feature/uat2-base' -ExpectedBaseSha ('b' * 40) -Attempts 3 -IntervalSeconds 0
    $helperExit = $LASTEXITCODE
    $result = ($raw -join "`n") | ConvertFrom-Json
    [ordered]@{ case = $MockCase; exitCode = $helperExit; result = $result; reads = @($global:mergePreflightTestReads.ToArray()) } | ConvertTo-Json -Depth 8 -Compress
    exit 0
}

$cases = @(
    @('clean', 0, 'identity_and_mergeability_confirmed', 1),
    @('unknown_then_true', 0, 'identity_and_mergeability_confirmed', 2),
    @('unknown_forever', 1, 'mergeability_unknown', 3),
    @('unknown_state_true_boolean', 1, 'mergeability_unknown', 3),
    @('unknown_then_head_drift', 1, 'head_changed', 2),
    @('false', 1, 'not_mergeable', 1),
    @('head_drift', 1, 'head_changed', 1),
    @('live_base_drift', 1, 'base_changed', 1),
    @('cached_pr_base_differs', 0, 'identity_and_mergeability_confirmed', 1),
    @('wrong_branch', 1, 'base_branch_changed', 1),
    @('wrong_repository', 1, 'pr_identity_mismatch', 1),
    @('wrong_pr', 1, 'pr_identity_mismatch', 1),
    @('closed', 1, 'pr_not_open', 1),
    @('merged', 1, 'pr_not_open', 1),
    @('draft', 1, 'pr_draft_or_unconfirmed', 1),
    @('missing_draft', 1, 'pr_draft_or_unconfirmed', 1),
    @('blocked', 1, 'merge_blocked', 1),
    @('behind', 1, 'merge_blocked', 1),
    @('string_true', 1, 'mergeability_unrecognized', 1),
    @('unrecognized_state', 1, 'mergeability_unrecognized', 1),
    @('unstable_checks_not_attested', 0, 'identity_and_mergeability_confirmed', 1),
    @('read_failure', 1, 'github_read_failed', 1),
    @('invalid_json', 1, 'github_invalid_json', 1)
)
$results = foreach ($case in $cases) {
    # 每例独立 PowerShell，防止 mock、LASTEXITCODE 与脚本退出语义互相污染。
    $text = & pwsh -NoProfile -File $PSCommandPath -MockCase $case[0] -HelperPath $HelperPath
    if ($LASTEXITCODE -ne 0) { throw "test_child_failed:$($case[0])" }
    $actual = ($text -join "`n") | ConvertFrom-Json
    if ($actual.exitCode -ne $case[1] -or $actual.result.reason -cne $case[2] -or
        $actual.result.attemptsUsed -ne $case[3] -or $actual.result.approved -ne ($case[1] -eq 0)) {
        throw "unexpected_result:$($case[0]):$($actual | ConvertTo-Json -Depth 6 -Compress)"
    }
    $readLimit = $case[3] * 2
    if ($actual.reads.Count -gt $readLimit -or $actual.reads.Count -lt 1) { throw "unbounded_reads:$($case[0])" }
    if ($actual.result.scope -notmatch 'required checks.*authorization remain separate') { throw 'scope_not_disclosed' }
    [ordered]@{ case = $case[0]; pass = $true; exitCode = $actual.exitCode; reason = $actual.result.reason; attemptsUsed = $actual.result.attemptsUsed; getCount = $actual.reads.Count }
}
[ordered]@{ passed = $results.Count; failed = 0; results = @($results) } | ConvertTo-Json -Depth 5
