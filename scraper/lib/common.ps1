# Common helpers: HTTP, JSON, files. ASCII only (must run on Windows PowerShell 5.1 and PowerShell 7).

Add-Type -AssemblyName System.Net.Http
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$script:Http = $null
$script:LastReq = @{}
$script:HostFails = @{}
$script:HostBlocked = @{}
$script:DelayMs = 1200
$script:ReqCount = 0
$script:IsCore = $PSVersionTable.PSVersion.Major -ge 6
if (-not $script:IsCore) { Add-Type -AssemblyName System.Web.Extensions }

function Initialize-Http([string]$UserAgent, [int]$DelayMs) {
    $h = New-Object System.Net.Http.HttpClientHandler
    $h.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
    $script:Http = New-Object System.Net.Http.HttpClient($h)
    $script:Http.Timeout = [TimeSpan]::FromSeconds(45)
    [void]$script:Http.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', $UserAgent)
    [void]$script:Http.DefaultRequestHeaders.TryAddWithoutValidation('Accept-Language', 'pl-PL,pl;q=0.9,en;q=0.5')
    $script:DelayMs = $DelayMs
}

function Test-HostBlocked([string]$HostName) { return [bool]$script:HostBlocked[$HostName] }

# Polite GET: one request per host every DelayMs, gives up on a host after repeated refusals.
function Get-Url([string]$Url) {
    $hn = ([Uri]$Url).Host
    if ($script:HostBlocked[$hn]) { return $null }
    for ($i = 0; $i -lt 3; $i++) {
        $last = $script:LastReq[$hn]
        if ($last) {
            $wait = $script:DelayMs - ([DateTime]::UtcNow - $last).TotalMilliseconds
            if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
        }
        $script:LastReq[$hn] = [DateTime]::UtcNow
        $script:ReqCount++
        try {
            $r = $script:Http.GetAsync($Url).GetAwaiter().GetResult()
            $code = [int]$r.StatusCode
            if ($code -eq 200) {
                $script:HostFails[$hn] = 0
                $bytes = $r.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
                return [Text.Encoding]::UTF8.GetString($bytes)
            }
            if ($code -eq 404) { return $null }
            Write-Host "  HTTP $code $Url"
            if ($code -eq 403 -or $code -eq 429) {
                $script:HostFails[$hn] = 1 + [int]$script:HostFails[$hn]
                if ($script:HostFails[$hn] -ge 4) {
                    Write-Host "  !! $hn refuses requests - skipping it for the rest of this run"
                    $script:HostBlocked[$hn] = $true
                    return $null
                }
                Start-Sleep -Seconds (15 * ($i + 1))
            } else {
                Start-Sleep -Seconds 3
            }
        } catch {
            Write-Host "  request error: $($_.Exception.Message)"
            Start-Sleep -Seconds 3
        }
    }
    return $null
}

# JSON parse that returns dictionaries/arrays on both PowerShell editions and has no 2 MB limit.
function ConvertFrom-JsonDict([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return $null }
    if ($script:IsCore) {
        return (ConvertFrom-Json -InputObject $Text -AsHashtable -Depth 100)
    }
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = [int]::MaxValue
    $ser.RecursionLimit = 200
    return $ser.DeserializeObject($Text)
}

function ConvertTo-JsonText($Obj) {
    return (ConvertTo-Json -InputObject $Obj -Depth 12 -Compress)
}

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-TextFile([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
    [IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try { return (ConvertFrom-JsonDict ([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8))) } catch { return $null }
}

function Write-JsonFile([string]$Path, $Obj) { Write-TextFile $Path (ConvertTo-JsonText $Obj) }

function Write-JsFile([string]$Path, [string]$VarName, $Obj) {
    Write-TextFile $Path ("window.$VarName = " + (ConvertTo-JsonText $Obj) + ";")
}

function Get-NowUtcString { return [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') }

function Get-WarsawNow {
    $tz = $null
    foreach ($id in 'Central European Standard Time', 'Europe/Warsaw') {
        try { $tz = [TimeZoneInfo]::FindSystemTimeZoneById($id); break } catch {}
    }
    if ($tz) { return [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $tz) }
    return [DateTime]::UtcNow.AddHours(1)
}

function ConvertTo-Int($v) {
    if ($null -eq $v) { return 0 }
    $s = ([string]$v) -replace '[^\d]', ''
    if ($s -eq '') { return 0 }
    try { return [int64]$s } catch { return 0 }
}

function Get-Median($values) {
    $a = @($values | Sort-Object)
    $n = $a.Count
    if ($n -eq 0) { return $null }
    if ($n % 2 -eq 1) { return [double]$a[($n - 1) / 2] }
    return ([double]$a[$n / 2 - 1] + [double]$a[$n / 2]) / 2
}

function Get-Quantile($sorted, [double]$q) {
    $a = @($sorted)
    $n = $a.Count
    if ($n -eq 0) { return $null }
    $pos = ($n - 1) * $q
    $lo = [Math]::Floor($pos); $hi = [Math]::Ceiling($pos)
    return [double]$a[$lo] + ([double]$a[$hi] - [double]$a[$lo]) * ($pos - $lo)
}

function Get-SafeName([string]$s) {
    return (($s.ToLower()) -replace '[^a-z0-9]+', '_').Trim('_')
}
