# Daily job: auctions (RajAuto + Fabryka Klasykow) -> merge -> Polish market valuation -> site data.
# Usage:  run.ps1                 full refresh
#         run.ps1 -Mode rate      only the JPY exchange rate
#         run.ps1 -Limit 30       full refresh but value only the first 30 cars (testing)
# ASCII only: must run on Windows PowerShell 5.1 and PowerShell 7 (GitHub Actions).
param(
    [ValidateSet('full', 'rate')][string]$Mode = 'full',
    [int]$Limit = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$lib = Join-Path $PSScriptRoot 'lib'
. (Join-Path $lib 'common.ps1')
. (Join-Path $lib 'sources.ps1')
. (Join-Path $lib 'mapping.ps1')
. (Join-Path $lib 'valuation.ps1')

$cfg = Read-JsonFile (Join-Path $root 'config.json')
if (-not $cfg) { throw 'config.json missing or invalid' }
$stateDir = Join-Path $root 'state'
$dataDir = Join-Path (Join-Path $root 'site') 'data'
Initialize-Http ([string]$cfg.scraper.userAgent) ([int]$cfg.scraper.delayMs)
$started = [DateTime]::UtcNow

# ---------------- exchange rate (NBP, table A) ----------------
$ratePath = Join-Path $stateDir 'rate.json'
$rate = Read-JsonFile $ratePath
$nbp = $null
try { $nbp = ConvertFrom-JsonDict (Get-Url 'https://api.nbp.pl/api/exchangerates/rates/a/jpy/?format=json') } catch {}
if ($nbp -and $nbp['rates']) {
    $r0 = @($nbp['rates'])[0]
    $rate = @{ mid = [double]$r0['mid']; date = [string]$r0['effectiveDate']; fetched = (Get-NowUtcString) }
    Write-JsonFile $ratePath $rate
}
if (-not $rate) { throw 'No JPY rate available (NBP unreachable and no saved rate)' }
Write-JsFile (Join-Path $dataDir 'rate.js') 'RATE' $rate
Write-Host ("JPY rate: {0} ({1})  ->  1 000 000 JPY = {2:N0} PLN" -f $rate.mid, $rate.date, ($rate.mid * 1000000))
if ($Mode -eq 'rate') { return }
$jpy = [double]$rate.mid

# ---------------- auctions ----------------
$raj = @(Get-RajAutoCars)
$makerSet = @{}
foreach ($k in $script:MakerMap.Keys) { $makerSet[$k] = $true }
$modelsByMaker = @{}
foreach ($c in $raj) {
    $makerSet[$c.maker] = $true
    if (-not $modelsByMaker.ContainsKey($c.maker)) { $modelsByMaker[$c.maker] = @{} }
    $modelsByMaker[$c.maker][$c.model] = $true
}
$makers = @($makerSet.Keys | Sort-Object { $_.Length } -Descending)
$mbm = @{}
foreach ($k in $modelsByMaker.Keys) { $mbm[$k] = @($modelsByMaker[$k].Keys | Sort-Object { $_.Length } -Descending) }
$fab = @(Get-FabrykaCars $makers $mbm ([int]$cfg.scraper.fabrykaMaxPages))
if ($raj.Count -eq 0 -and $fab.Count -eq 0) { throw 'Both auction sources returned nothing - keeping the previous data' }
$all = Merge-Cars $raj $fab

$today = (Get-WarsawNow).ToString('yyyy-MM-dd')

# ---------------- history ----------------
$histPath = Join-Path $stateDir 'history.json'
$hist = Read-JsonFile $histPath
if (-not $hist) { $hist = @{} }
foreach ($c in $all.Values) {
    if ($c.startJpy -le 0) { continue }
    $sold = 0; $res = ''
    if ($c.result -and $c.result -ne 'Auction not started') {
        $res = $c.result
        $m = [regex]::Match($c.result, '(\d[\d,]{4,})')
        if ($m.Success) { $sold = [int64](ConvertTo-Int $m.Groups[1].Value) }
    }
    if ($hist.ContainsKey($c.id)) {
        $h = $hist[$c.id]
        $h['last'] = $today
        if ([int64]$h['s'] -ne $c.startJpy) {
            $h['ph'] = @($h['ph']) + , @($today, $c.startJpy)
            $h['s'] = $c.startJpy
        }
        if ($res) { $h['res'] = $res }
        if ($sold -gt 0) { $h['sold'] = $sold }
    } else {
        $hist[$c.id] = @{ d = $c.date; mk = $c.maker; md = $c.model; g = $c.grade; y = $c.year; km = $c.km; sc = $c.score; s = $c.startJpy; first = $today; last = $today; res = $res; sold = $sold; ph = @() }
    }
}
$cutoff = (Get-WarsawNow).AddDays(-400).ToString('yyyy-MM-dd')
foreach ($k in @($hist.Keys)) { if ([string]$hist[$k]['d'] -lt $cutoff) { [void]$hist.Remove($k) } }
Write-JsonFile $histPath $hist

# hammer-price ratios learned from recorded results
$ratios = @{ model = @{}; maker = @{}; all = @() }
$byModel = @{}
foreach ($k in $hist.Keys) {
    $h = $hist[$k]
    $mm = "$($h['mk'])|$($h['md'])"
    if (-not $byModel.ContainsKey($mm)) { $byModel[$mm] = New-Object System.Collections.Generic.List[object] }
    $byModel[$mm].Add(@{ id = $k; h = $h })
    if ([int64]$h['sold'] -gt 0 -and [int64]$h['s'] -gt 0) {
        $rt = [double]$h['sold'] / [double]$h['s']
        if ($rt -ge 1 -and $rt -le 20) {
            if (-not $ratios.model.ContainsKey($mm)) { $ratios.model[$mm] = @() }
            $ratios.model[$mm] += $rt
            $mk = [string]$h['mk']
            if (-not $ratios.maker.ContainsKey($mk)) { $ratios.maker[$mk] = @() }
            $ratios.maker[$mk] += $rt
            $ratios.all += $rt
        }
    }
}
function Get-BidEstimate($car) {
    $mm = "$($car.maker)|$($car.model)"
    if ($ratios.model.ContainsKey($mm) -and @($ratios.model[$mm]).Count -ge 3) { return @{ ratio = (Get-Median $ratios.model[$mm]); basis = 'model'; n = @($ratios.model[$mm]).Count } }
    if ($ratios.maker.ContainsKey($car.maker) -and @($ratios.maker[$car.maker]).Count -ge 8) { return @{ ratio = (Get-Median $ratios.maker[$car.maker]); basis = 'maker'; n = @($ratios.maker[$car.maker]).Count } }
    if (@($ratios.all).Count -ge 20) { return @{ ratio = (Get-Median $ratios.all); basis = 'all'; n = @($ratios.all).Count } }
    return @{ ratio = [double]$cfg.estimate.defaultBidMultiplier; basis = 'default'; n = 0 }
}

# ---------------- which auctions go on the site ----------------
$active = @($all.Values | Where-Object { $_.startJpy -gt 0 -and $_.date -ge $today } | Sort-Object { $_.date }, { $_.id })
Write-Host "On the site: $($active.Count) auctions with a start price (of $($all.Count) unique)"

# gallery + spec for cars only Fabryka lists (cached, limited per run)
$fabDir = Join-Path $stateDir 'fab'
$fabFetched = 0
foreach ($c in $active) {
    if ($c.src -contains 'rajauto') { continue }
    $fp = Join-Path $fabDir "$($c.id).json"
    $d = Read-JsonFile $fp
    if (-not $d -and $fabFetched -lt 150 -and ($Limit -le 0 -or $fabFetched -lt $Limit)) {
        $d = Get-FabrykaDetail $c.urls['fabryka']
        if ($d) { Write-JsonFile $fp $d; $fabFetched++ }
    }
    if ($d) {
        if (@($d['photos']).Count -gt 0) { $c.photos = @($d['photos']) }
        foreach ($f in 'color', 'body', 'steering', 'ac', 'inspection', 'chassis') { if ($d[$f]) { $c[$f] = [string]$d[$f] } }
        $c.equip = @($d['equip'])
    }
}
if (Test-Path $fabDir) {
    $keep = @{}; foreach ($c in $active) { $keep["$($c.id).json"] = $true }
    Get-ChildItem $fabDir -Filter *.json | Where-Object { -not $keep[$_.Name] -and $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-3) } | Remove-Item -Force
}

# ---------------- valuation ----------------
$cat = Get-OtomotoCatalog $stateDir
$apDict = Get-AutoplacDict $stateDir
$tol = [int]$cfg.valuation.yearTolerance
$capPct = [double]$cfg.valuation.capacityTolerancePct / 100.0
$summaries = New-Object System.Collections.Generic.List[object]
$detailDir = Join-Path $dataDir 'detail'
$valued = 0; $i = 0; $gems = @()

function Get-Cost([double]$bidPln, [int]$cc) {
    $ex = [double]$cfg.costs.exciseLargePct
    if ($cc -gt 0 -and $cc -le [int]$cfg.costs.exciseThresholdCc) { $ex = [double]$cfg.costs.exciseSmallPct }
    $cif = $bidPln + [double]$cfg.costs.transportPln
    return $cif * (1 + [double]$cfg.costs.dutyPct / 100) * (1 + $ex / 100) * (1 + [double]$cfg.costs.vatPct / 100)
}

foreach ($c in $active) {
    $i++
    $doValue = ($Limit -le 0 -or $i -le $Limit)
    $sel = $null; $market = $null
    $oto = Resolve-OtomotoModel $c $cat
    if ($oto -and $doValue -and $c.year -gt 1950) {
        $capFrom = 0; $capTo = 0
        if ($c.cc -gt 0) {
            $capFrom = [int]([Math]::Floor($c.cc * (1 - $capPct) / 50) * 50)
            $capTo = [int]([Math]::Ceiling($c.cc * (1 + $capPct) / 50) * 50)
        }
        $ids = @(Resolve-AutoplacIds $oto $apDict)
        $widened = $false
        foreach ($t in $tol, ($tol + 1)) {
            $yF = $c.year - $t; $yT = $c.year + $t
            $pO = Get-OtomotoPool $oto $yF $yT $capFrom $capTo $cfg $stateDir
            $pA = Get-AutoplacPool $ids $yF $yT $cfg $stateDir
            $comps = @()
            if ($pO) { $comps += @($pO['comps']) }
            if ($pA) { $comps += @($pA['comps']) }
            $s2 = Select-Comparables $c $comps $cfg $capFrom $capTo
            if (-not $sel -or $s2.n -gt $sel.n) {
                $sel = $s2
                $widened = ($t -ne $tol)
                $urlO = ''; $urlA = ''
                if ($pO) { $urlO = [string]$pO['url'] } else { $urlO = Get-OtomotoUrl $oto $yF $yT $capFrom $capTo 1 }
                if ($pA) { $urlA = [string]$pA['url'] }
                $market = [ordered]@{ makeName = $oto.makeName; modelName = $oto.modelName; yFrom = $yF; yTo = $yT; capFrom = $capFrom; capTo = $capTo; urlO = $urlO; urlA = $urlA }
            }
            if ($sel.n -ge 3) { break }
        }
        if ($widened -and $sel.n -gt 0) { $sel.conf = 'low' }
        $market['widened'] = $widened
        if ($sel.n -gt 0) { $valued++ }
        if ($i % 25 -eq 0) { Write-Host "  valued $i / $($active.Count)  (requests so far: $($script:ReqCount))" }
    }

    $est = Get-BidEstimate $c
    $estJpy = [int64]([Math]::Round($c.startJpy * $est.ratio / 1000) * 1000)
    $brand = Get-BrandName $c.maker $cat
    $title = (@($c.maker, $c.model, $c.grade) | Where-Object { $_ }) -join ' '

    $sum = [ordered]@{
        id = $c.id; lot = $c.lot; date = $c.date; site = $c.site; brand = $brand; title = $title
        year = $c.year; km = $c.km; cc = $c.cc; trans = $c.trans; score = $c.score
        start = $c.startJpy; est = $estJpy; estBasis = $est.basis
        img = @($c.photos)[0]; img2 = $null; src = @($c.src)
        med = $null; n = 0; conf = ''
    }
    if (@($c.photos).Count -gt 5) { $sum.img2 = @($c.photos)[5] }
    if ($sel -and $sel.n -gt 0) { $sum.med = [int64]$sel.med; $sum.n = $sel.n; $sum.conf = $sel.conf }
    $summaries.Add($sum)

    # detail file
    $similar = @()
    $mm = "$($c.maker)|$($c.model)"
    if ($byModel.ContainsKey($mm)) {
        $similar = @($byModel[$mm] | Where-Object { $_.id -ne $c.id } | Sort-Object { [string]$_.h['d'] } -Descending | Select-Object -First 15 | ForEach-Object {
            [ordered]@{ d = $_.h['d']; g = $_.h['g']; y = $_.h['y']; km = $_.h['km']; sc = $_.h['sc']; s = $_.h['s']; sold = $_.h['sold']; res = $_.h['res'] }
        })
    }
    $hh = $hist[$c.id]
    $det = [ordered]@{
        id = $c.id; photos = @($c.photos); sheet = $c.sheet
        maker = $c.maker; model = $c.model; grade = $c.grade
        color = $c.color; body = $c.body; steering = $c.steering; ac = $c.ac; inspection = $c.inspection; chassis = $c.chassis
        equip = @($c.equip); urls = $c.urls
        estRatio = [Math]::Round($est.ratio, 3); estN = $est.n
        market = $market
        val = $null; comps = @()
        hist = [ordered]@{ first = $hh['first']; changes = @($hh['ph']); similar = $similar }
    }
    if ($sel -and $sel.n -gt 0) {
        $det.val = [ordered]@{ n = $sel.n; med = $sel.med; lo = $sel.lo; hi = $sel.hi; medO = $sel.medO; nO = $sel.nO; medA = $sel.medA; nA = $sel.nA; conf = $sel.conf; version = $sel.version; kmMatch = $sel.kmMatch; dropped = $sel.dropped }
        $det.comps = @($sel.comps | ForEach-Object { , @([int64]$_['p'], [int]$_['y'], [int]$_['km'], [int]$_['cc'], [string]$_['t'], [string]$_['u'], [string]$_['s']) })
    }
    Write-TextFile (Join-Path $detailDir "$($c.id).js") ('window.DETAIL=window.DETAIL||{};window.DETAIL[' + (ConvertTo-JsonText $c.id) + ']=' + (ConvertTo-JsonText $det) + ';')

    # "gem" check with the default settings
    # (same rules as the site: enough listings, undamaged car, start price that is not merely symbolic)
    if ($sel -and $sel.n -ge [int]$cfg.gems.minComparables -and $sel.conf -ne 'low' -and $c.score -notmatch '^R|^A$|\*') {
        $safe = [double]$sel.med * (1 - [double]$cfg.valuation.safetyDiscountPct / 100)
        $cost = Get-Cost ($estJpy * $jpy) $c.cc
        $profit = ($safe - $cost) / $cost * 100
        $breakEven = $safe / ((Get-Cost 0 $c.cc) / [double]$cfg.costs.transportPln) - [double]$cfg.costs.transportPln
        $symbolic = ($est.basis -eq 'default') -and ($breakEven -gt 0) -and (($c.startJpy * $jpy) -lt 0.3 * $breakEven)
        if ($profit -ge [double]$cfg.gems.minProfitPct -and -not $symbolic) { $gems += @{ id = $c.id; title = $title; year = $c.year; profit = [Math]::Round($profit); date = $c.date } }
    }
}

# remove detail files of auctions that are gone
if (Test-Path $detailDir) {
    $keep = @{}; foreach ($s in $summaries) { $keep["$($s.id).js"] = $true }
    Get-ChildItem $detailDir -Filter *.js | Where-Object { -not $keep[$_.Name] } | Remove-Item -Force
}
# drop valuation cache files nobody used for a week
$valDir = Join-Path $stateDir 'val'
if (Test-Path $valDir) { Get-ChildItem $valDir -Filter *.json | Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7) } | Remove-Item -Force }

Write-JsFile (Join-Path $dataDir 'cars.js') 'CARS' $summaries.ToArray()
$blocked = @($script:HostBlocked.Keys)
$meta = [ordered]@{
    updated = (Get-NowUtcString)
    counts = [ordered]@{ rajauto = $raj.Count; fabryka = $fab.Count; unique = $all.Count; shown = $summaries.Count; valued = $valued }
    costs = $cfg.costs
    valuation = [ordered]@{ safetyDiscountPct = $cfg.valuation.safetyDiscountPct; targetMarginPct = $cfg.valuation.targetMarginPct }
    gems = $cfg.gems
    defaultBidMultiplier = $cfg.estimate.defaultBidMultiplier
    blocked = $blocked
    partial = ($Limit -gt 0)
}
Write-JsFile (Join-Path $dataDir 'meta.js') 'META' $meta

# ---------------- notifications (only brand-new gems) ----------------
$notPath = Join-Path $stateDir 'notified.json'
$notified = Read-JsonFile $notPath
if (-not $notified) { $notified = @{} }
$newGems = @($gems | Where-Object { -not $notified.ContainsKey($_.id) })
$siteUrl = [string]$env:SITE_URL
foreach ($g in $newGems) {
    $l = [string][char]0x142
    $head = "Pere${l}ka"
    $prof = "op${l}acalno" + [char]0x15B + [char]0x107
    $msg = "${head}: $($g.title) $($g.year) - $prof ok. $($g.profit)% (aukcja $($g.date))"
    if ($siteUrl) { $msg += " $siteUrl#/auto/$($g.id)" }
    try {
        if ($env:NTFY_TOPIC) {
            $content = New-Object System.Net.Http.StringContent($msg, [Text.Encoding]::UTF8, 'text/plain')
            [void]$script:Http.PostAsync("https://ntfy.sh/$($env:NTFY_TOPIC)", $content).GetAwaiter().GetResult()
        }
        if ($env:TELEGRAM_BOT_TOKEN -and $env:TELEGRAM_CHAT_ID) {
            $u = "https://api.telegram.org/bot$($env:TELEGRAM_BOT_TOKEN)/sendMessage?chat_id=$($env:TELEGRAM_CHAT_ID)&text=" + [Uri]::EscapeDataString($msg)
            [void]$script:Http.GetAsync($u).GetAwaiter().GetResult()
        }
    } catch { Write-Host "  notification error: $($_.Exception.Message)" }
    $notified[$g.id] = $today
}
foreach ($k in @($notified.Keys)) { if ([string]$notified[$k] -lt $cutoff) { [void]$notified.Remove($k) } }
Write-JsonFile $notPath $notified

$mins = [Math]::Round(([DateTime]::UtcNow - $started).TotalMinutes, 1)
Write-Host "Done in $mins min. Shown: $($summaries.Count), valued: $valued, gems: $($gems.Count) (new: $($newGems.Count)), requests: $($script:ReqCount)"
if ($blocked.Count -gt 0) { Write-Host "Blocked hosts this run: $($blocked -join ', ')" }
