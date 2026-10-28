[CmdletBinding()]
param(
    [Parameter(Mandatory)][uri]$Registry,
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][ValidatePattern('^sha256:[0-9a-f]{64}$')][string]$ExpectedDigest,
    [securestring]$Authorization,
    [ValidateRange(1, 30)][int]$TimeoutSeconds = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 摘要寻址只读请求；地址不携带凭据，也不允许重定向扩大访问范围。
if (-not $Registry.IsAbsoluteUri -or
    ($Registry.Scheme -ne 'https' -and -not ($Registry.Scheme -eq 'http' -and $Registry.IsLoopback)) -or
    $Registry.UserInfo -or $Registry.Query -or $Registry.Fragment -or $Registry.AbsolutePath -ne '/') {
    throw 'registry_origin_invalid'
}
if ($Repository -cnotmatch '^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$') {
    throw 'registry_repository_invalid'
}

$imageTypes = @('application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json')
$indexTypes = @('application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.oci.image.index.v1+json')
$acceptedTypes = $imageTypes + $indexTypes
$result = [ordered]@{ verified = $false; reason = 'request_failed'; httpStatus = $null; requestedDigest = $ExpectedDigest }
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $false
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
$request = $null
$response = $null

function Test-Descriptor($Value) {
    # JSON 结构错误不能被 ToString 或整数强转伪装成合法镜像描述符。
    return ($Value -is [System.Collections.IDictionary] -and
        $Value.Contains('digest') -and $Value.digest -is [string] -and $Value.digest -cmatch '^sha256:[0-9a-f]{64}$' -and
        $Value.Contains('size') -and ($Value.size -is [long] -or $Value.size -is [int] -or $Value.size -is [System.Numerics.BigInteger]) -and $Value.size -ge 0 -and
        $Value.Contains('mediaType') -and $Value.mediaType -is [string] -and $Value.mediaType.Length -gt 0)
}

try {
    $endpoint = [uri]::new($Registry, "v2/$Repository/manifests/$ExpectedDigest")
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $endpoint)
    foreach ($mediaType in $acceptedTypes) { $request.Headers.Accept.ParseAdd($mediaType) }
    if ($null -ne $Authorization) {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Authorization)
        try {
            $header = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::Parse($header)
        } finally {
            $header = $null
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $result.httpStatus = [int]$response.StatusCode
    if ($result.httpStatus -ne 200) { $result.reason = 'http_status'; throw 'manifest_rejected' }

    # 在任何解码/JSON 操作前取得并校验原始字节，不能重新序列化后计算摘要。
    [byte[]]$bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    $result.rawDigest = 'sha256:' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    $result.byteLength = $bytes.Length
    if ($result.rawDigest -cne $ExpectedDigest) { $result.reason = 'body_digest_mismatch'; throw 'manifest_rejected' }
    if ($response.Headers.Contains('Docker-Content-Digest')) {
        $digestHeaders = @($response.Headers.GetValues('Docker-Content-Digest'))
        if ($digestHeaders.Count -ne 1 -or $digestHeaders[0] -cne $ExpectedDigest) { $result.reason = 'header_digest_mismatch'; throw 'manifest_rejected' }
        $result.responseDigest = $digestHeaders[0]
    }
    # 摘要头不是必需证明：摘要寻址 GET 的原始字节必须与已知构建摘要相等。
    $contentType = $response.Content.Headers.ContentType
    if ($null -eq $contentType -or $contentType.MediaType -cnotin $acceptedTypes) { $result.reason = 'content_type_invalid'; throw 'manifest_rejected' }
    $result.mediaType = $contentType.MediaType
    $result.reason = 'json_invalid'
    $jsonText = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $manifest = ConvertFrom-Json -InputObject $jsonText -AsHashtable -NoEnumerate -ErrorAction Stop
    $result.reason = 'manifest_shape_invalid'
    if ($manifest -isnot [System.Collections.IDictionary] -or
        -not $manifest.Contains('schemaVersion') -or ($manifest.schemaVersion -isnot [int] -and $manifest.schemaVersion -isnot [long]) -or $manifest.schemaVersion -ne 2 -or
        -not $manifest.Contains('mediaType') -or $manifest.mediaType -isnot [string] -or $manifest.mediaType -cne $result.mediaType) { throw 'manifest_rejected' }
    if ($result.mediaType -cin $imageTypes) {
        if (-not $manifest.Contains('config') -or -not (Test-Descriptor $manifest.config) -or
            -not $manifest.Contains('layers') -or $manifest.layers -isnot [array]) { throw 'manifest_rejected' }
        foreach ($layer in $manifest.layers) { if (-not (Test-Descriptor $layer)) { throw 'manifest_rejected' } }
        $result.kind = 'image-manifest'
        $result.configDigest = $manifest.config.digest
        $result.layerCount = $manifest.layers.Count
    } else {
        if (-not $manifest.Contains('manifests') -or $manifest.manifests -isnot [array] -or $manifest.manifests.Count -eq 0) { throw 'manifest_rejected' }
        $children = @()
        foreach ($child in $manifest.manifests) {
            if (-not (Test-Descriptor $child) -or $child.mediaType -cnotin $acceptedTypes) { throw 'manifest_rejected' }
            $entry = [ordered]@{ digest = $child.digest; mediaType = $child.mediaType }
            if ($child.Contains('platform')) {
                $platform = $child.platform
                if ($platform -isnot [System.Collections.IDictionary] -or -not $platform.Contains('os') -or $platform.os -isnot [string] -or -not $platform.os -or
                    -not $platform.Contains('architecture') -or $platform.architecture -isnot [string] -or -not $platform.architecture) { throw 'manifest_rejected' }
                $entry.os = $platform.os
                $entry.architecture = $platform.architecture
                if ($platform.Contains('variant')) {
                    if ($platform.variant -isnot [string]) { throw 'manifest_rejected' }
                    $entry.variant = $platform.variant
                }
            }
            $children += $entry
        }
        $result.kind = 'image-index'
        $result.children = $children
    }
    $result.verified = $true
    $result.reason = 'verified'
} catch {
    # 网络、鉴权、正文和异常细节可能含敏感数据；仅输出白名单阶段和摘要。
} finally {
    if ($null -ne $response) { $response.Dispose() }
    if ($null -ne $request) { $request.Dispose() }
    $client.Dispose()
}
$result | ConvertTo-Json -Depth 8 -Compress
if ($result.verified) { exit 0 }
exit 1
