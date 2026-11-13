# Polish market valuation from Otomoto and Autoplac listings. ASCII only.

function Test-Fresh($obj, [double]$hours) {
    if (-not $obj -or -not $obj['ts']) { return $false }
    try {
        $ts = [DateTime]::Parse([string]$obj['ts'], [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal)
        return (([DateTime]::UtcNow - $ts).TotalHours -lt $hours)
    } catch { return $false }
}

function Get-EmbeddedJson([string]$html, [string]$scriptId) {
    if (-not $html) { return $null }
    $m = [regex]::Match($html, '<script id="' + $scriptId + '"[^>]*>(.*?)</script>', 'Singleline')
    if (-not $m.Success) { return $null }
    try { return (ConvertFrom-JsonDict $m.Groups[1].Value) } catch { return $null }
}

# ---------- catalogs ----------

function Get-OtomotoCatalog([string]$stateDir) {
    $path = Join-Path $stateDir 'otomoto_catalog.json'
    $cached = Read-JsonFile $path
    if (Test-Fresh $cached 168) { return $cached['makes'] }
    Write-Host 'Otomoto: refreshing make/model catalog'
    $nd = Get-EmbeddedJson (Get-Url 'https://www.otomoto.pl/osobowe/porsche') '__NEXT_DATA__'
    $makes = @{}
    try {
        $urql = $nd['props']['pageProps']['urqlState']
        foreach ($k in @($urql.Keys)) {
            $data = [string]$urql[$k]['data']
            if (-not $data.Contains('"filters"')) { continue }
            $fl = (ConvertFrom-JsonDict $data)['filters']
            if (-not $fl -or -not $fl['states']) { continue }
            foreach ($st in $fl['states']) {
                if ($st['filterId'] -eq 'filter_enum_make') {
                    foreach ($g in $st['values']) { foreach ($v in $g['values']) {
                        $id = [string]$v['id']
                        if (-not $makes.ContainsKey($id)) { $makes[$id] = @{ name = [string]$v['name']; models = @() } } else { $makes[$id]['name'] = [string]$v['name'] }
                    } }
                }
                elseif ($st['filterId'] -eq 'filter_enum_model') {
                    $conds = @($st['conditions'])
                    if ($conds.Count -ne 1 -or $conds[0]['filterId'] -ne 'filter_enum_make') { continue }
                    $mk = [string]$conds[0]['value']
                    $list = @()
                    foreach ($g in $st['values']) { foreach ($v in $g['values']) { $list += @{ id = [string]$v['id']; name = ([string]$v['name']).Trim() } } }
                    if (-not $makes.ContainsKey($mk)) { $makes[$mk] = @{ name = $mk; models = @() } }
                    $makes[$mk]['models'] = $list
                }
            }
        }
    } catch { Write-Host "  catalog parse error: $($_.Exception.Message)" }
    if ($makes.Count -gt 20) {
        Write-JsonFile $path @{ ts = (Get-NowUtcString); makes = $makes }
        return $makes
    }
    if ($cached) { return $cached['makes'] }
    return $makes
}

function Get-AutoplacDict([string]$stateDir) {
    $path = Join-Path $stateDir 'autoplac_dict.json'
    $cached = Read-JsonFile $path
    if (Test-Fresh $cached 168) { return $cached['brands'] }
    Write-Host 'Autoplac: refreshing brand/model dictionary'
    $st = Get-EmbeddedJson (Get-Url 'https://autoplac.pl/oferty/samochody-osobowe') 'ng-state'
    $brands = @()
    try {
        foreach ($k in @($st.Keys)) {
            if ($k -notlike '*vehicle-dictionary/search/brand?vehicleType=PASSENGER*') { continue }
            $body = $st[$k]['body']
            $seen = @{}
            foreach ($grp in 'brands', 'popularBrands') {
                foreach ($b in @($body[$grp])) {
                    $id = [string]$b['value']
                    if ($seen[$id]) { continue }
                    $seen[$id] = $true
                    $models = @()
                    foreach ($m in @($b['models'])) { $models += @{ value = [int]$m['value']; displayName = [string]$m['displayName'] } }
                    $brands += @{ value = [int]$b['value']; displayName = [string]$b['displayName']; models = $models }
                }
            }
        }
    } catch { Write-Host "  dictionary parse error: $($_.Exception.Message)" }
    if ($brands.Count -gt 20) {
        Write-JsonFile $path @{ ts = (Get-NowUtcString); brands = $brands }
        return $brands
    }
    if ($cached) { return $cached['brands'] }
    return $brands
}

# ---------- listing pools ----------

function Get-OtomotoUrl($oto, [int]$yFrom, [int]$yTo, [int]$capFrom, [int]$capTo, [int]$page) {
    $p = @()
    $p += 'search%5Bfilter_enum_make%5D=' + $oto.make
    $p += 'search%5Bfilter_enum_model%5D=' + $oto.model
    $p += 'search%5Bfilter_float_year%3Afrom%5D=' + $yFrom
    $p += 'search%5Bfilter_float_year%3Ato%5D=' + $yTo
    $p += 'search%5Bfilter_enum_damaged%5D=0'
    if ($capFrom -gt 0) {
        $p += 'search%5Bfilter_float_engine_capacity%3Afrom%5D=' + $capFrom
        $p += 'search%5Bfilter_float_engine_capacity%3Ato%5D=' + $capTo
    }
    if ($page -gt 1) { $p += 'page=' + $page }
    return 'https://www.otomoto.pl/osobowe?' + ($p -join '&')
}

function Read-OtomotoPage([string]$html) {
    $res = @{ total = -1; comps = @() }
    $nd = Get-EmbeddedJson $html '__NEXT_DATA__'
    if (-not $nd) { return $res }
    try {
        $urql = $nd['props']['pageProps']['urqlState']
        foreach ($k in @($urql.Keys)) {
            $data = [string]$urql[$k]['data']
            if (-not $data.Contains('"advertSearch"')) { continue }
            $as = (ConvertFrom-JsonDict $data)['advertSearch']
            $res.total = [int]$as['totalCount']
            $list = @()
            foreach ($e in @($as['edges'])) {
                $n = $e['node']
                $amt = $n['price']['amount']
                if (-not $amt -or $amt['currencyCode'] -ne 'PLN') { continue }
                $c = @{ p = [int64]$amt['units']; y = 0; km = 0; cc = 0; t = [string]$n['title']; u = [string]$n['url']; s = 'o' }
                foreach ($par in @($n['parameters'])) {
                    switch ([string]$par['key']) {
                        'year' { $c.y = [int](ConvertTo-Int $par['value']) }
                        'mileage' { $c.km = [int](ConvertTo-Int $par['value']) }
                        'engine_capacity' { $c.cc = [int](ConvertTo-Int $par['value']) }
                        'version' { $c.t = $c.t + ' ' + [string]$par['displayValue'] }
                    }
                }
                if ($c.t.Length -gt 90) { $c.t = $c.t.Substring(0, 90) }
                if ($c.p -gt 0) { $list += $c }
            }
            $res.comps = $list
            break
        }
    } catch { Write-Host "  otomoto parse error: $($_.Exception.Message)" }
    return $res
}

function Get-OtomotoPool($oto, [int]$yFrom, [int]$yTo, [int]$capFrom, [int]$capTo, $cfg, [string]$stateDir) {
    $name = 'o_' + (Get-SafeName "$($oto.make)_$($oto.model)") + "_${yFrom}_${yTo}_${capFrom}_${capTo}"
    $path = Join-Path (Join-Path $stateDir 'val') "$name.json"
    $cached = Read-JsonFile $path
    if (Test-Fresh $cached $cfg.valuation.cacheHours) { return $cached }
    $url = Get-OtomotoUrl $oto $yFrom $yTo $capFrom $capTo 1
    $html = Get-Url $url
    if (-not $html) { return $cached }
    $first = Read-OtomotoPage $html
    if ($first.total -lt 0) { return $cached }
    $comps = @($first.comps)
    $pages = [Math]::Min([int]$cfg.valuation.maxPagesPerQuery, [Math]::Ceiling($first.total / 32))
    for ($pg = 2; $pg -le $pages; $pg++) {
        $h = Get-Url (Get-OtomotoUrl $oto $yFrom $yTo $capFrom $capTo $pg)
        if (-not $h) { break }
        $comps += @((Read-OtomotoPage $h).comps)
    }
    $pool = @{ ts = (Get-NowUtcString); total = $first.total; url = $url; comps = $comps }
    Write-JsonFile $path $pool
    return $pool
}

function Get-AutoplacPool($ids, [int]$yFrom, [int]$yTo, $cfg, [string]$stateDir) {
    if (@($ids).Count -eq 0) { return $null }
    $idStr = @($ids) -join ','
    $name = 'a_' + (Get-SafeName $idStr) + "_${yFrom}_${yTo}"
    $path = Join-Path (Join-Path $stateDir 'val') "$name.json"
    $cached = Read-JsonFile $path
    if (Test-Fresh $cached $cfg.valuation.cacheHours) { return $cached }
    $url = "https://autoplac.pl/oferty/samochody-osobowe?brandModelIds=$idStr&yearFrom=$yFrom&yearTo=$yTo"
    $st = Get-EmbeddedJson (Get-Url $url) 'ng-state'
    if (-not $st) { return $cached }
    $comps = @(); $total = -1
    try {
        foreach ($k in @($st.Keys)) {
            if ($k -notlike '*offers/search*') { continue }
            $body = $st[$k]['body']
            $total = [int]$body['offerCount']
            foreach ($it in @($body['offerList'])) {
                $o = $it['offer']
                if (-not $o) { continue }
                if ($o['vehicleOrigin'] -eq 'TO_IMPORT') { continue }
                if ($o['locationCountry'] -and $o['locationCountry'] -ne 'POLAND') { continue }
                $pi = $o['priceInfo']
                if (-not $pi -or $pi['currency'] -ne 'PLN' -or -not $pi['primary']) { continue }
                $price = [int64](ConvertTo-Int $pi['primary']['price'])
                if ($price -le 0) { continue }
                $t = [string]$o['title']
                if ($t.Length -gt 90) { $t = $t.Substring(0, 90) }
                $comps += @{ p = $price; y = [int]$o['productionYear']; km = [int](ConvertTo-Int $o['mileage']); cc = [int](ConvertTo-Int $o['engineCapacity']); t = $t; u = ('https://autoplac.pl' + [string]$o['webUrl']); s = 'a' }
            }
            break
        }
    } catch { Write-Host "  autoplac parse error: $($_.Exception.Message)" }
    if ($total -lt 0) { return $cached }
    $pool = @{ ts = (Get-NowUtcString); total = $total; url = $url; comps = $comps }
    Write-JsonFile $path $pool
    return $pool
}

# ---------- choosing comparable listings for one car ----------

function Select-Comparables($car, $comps, $cfg, [int]$capFrom, [int]$capTo) {
    $res = @{ n = 0; med = $null; lo = $null; hi = $null; medO = $null; nO = 0; medA = $null; nA = 0; conf = ''; version = ''; kmMatch = $false; dropped = 0; comps = @() }
    $seen = @{}
    $pool = New-Object System.Collections.Generic.List[object]
    foreach ($c in @($comps)) {
        if (-not $c -or -not $c['u'] -or $seen[[string]$c['u']]) { continue }
        $seen[[string]$c['u']] = $true
        if ($capFrom -gt 0) {
            $cc = [int]$c['cc']
            if ($cc -le 0 -or $cc -lt $capFrom -or $cc -gt $capTo) { continue }
        }
        $pool.Add($c)
    }
    if ($pool.Count -eq 0) { return $res }
    $cur = $pool.ToArray()

    # same version (S580 vs S350), premium variants (GT3, Turbo S ...)
    $tok = Get-GradeToken $car
    $pw = Get-PremiumWord $car
    $normT = { param($x) (([string]$x['t']).ToUpper() -replace '[\s\-]', '') }
    $done = $false
    if ($tok) {
        $m = @($cur | Where-Object { (& $normT $_).Contains($tok) })
        if ($m.Count -ge 3) { $cur = $m; $res.version = $tok; $done = $true }
    }
    if (-not $done -and $pw) {
        $w = $pw -replace '\s', ''
        $m = @($cur | Where-Object { (& $normT $_).Contains($w) })
        if ($m.Count -ge 3) { $cur = $m; $res.version = $pw; $done = $true }
    }
    if (-not $done -and -not $pw) {
        $strong = @('GT3', 'GT2', 'TURBOS', 'BLACKSERIES', 'HELLCAT', 'DEMON', 'TRACKHAWK', 'SHELBY', 'Z06', 'ZR1', 'SVR')
        if ($car.maker -eq 'PORSCHE') { $strong += 'TURBO' }
        $m = @($cur | Where-Object { $t = (& $normT $_); $bad = $false; foreach ($s in $strong) { if ($t.Contains($s)) { $bad = $true; break } }; -not $bad })
        if ($m.Count -ge 3) { $cur = $m }
    }
    if (-not $done -and ($car.maker -eq 'MERCEDES AMG' -or $car.maker -eq 'AMG')) {
        $m = @($cur | Where-Object { (& $normT $_).Contains('AMG') })
        if ($m.Count -ge 3) { $cur = $m; $res.version = 'AMG' }
    }

    # similar mileage
    if ($car.km -gt 0) {
        $band = [Math]::Max($car.km * $cfg.valuation.mileageTolerancePct / 100.0, [double]$cfg.valuation.mileageToleranceMinKm)
        $m = @($cur | Where-Object { [int]$_['km'] -gt 0 -and [Math]::Abs([int]$_['km'] - $car.km) -le $band })
        if ($m.Count -ge 4) { $cur = $m; $res.kmMatch = $true }
    }

    # drop absurd prices
    $before = $cur.Count
    $prices = @($cur | ForEach-Object { [double]$_['p'] } | Sort-Object)
    if ($prices.Count -ge 5) {
        $q1 = Get-Quantile $prices 0.25; $q3 = Get-Quantile $prices 0.75; $iqr = $q3 - $q1
        $loF = $q1 - 1.5 * $iqr; $hiF = $q3 + 1.5 * $iqr
        $cur = @($cur | Where-Object { [double]$_['p'] -ge $loF -and [double]$_['p'] -le $hiF })
    } elseif ($prices.Count -ge 3) {
        $md = Get-Median $prices
        $cur = @($cur | Where-Object { [double]$_['p'] -ge 0.4 * $md -and [double]$_['p'] -le 2.5 * $md })
    }
    $res.dropped = $before - $cur.Count

    $cur = @($cur | Sort-Object { [double]$_['p'] })
    $res.n = $cur.Count
    if ($cur.Count -eq 0) { return $res }
    $all = @($cur | ForEach-Object { [double]$_['p'] })
    $res.med = [Math]::Round((Get-Median $all))
    $res.lo = [int64]$all[0]; $res.hi = [int64]$all[$all.Count - 1]
    $o = @($cur | Where-Object { $_['s'] -eq 'o' } | ForEach-Object { [double]$_['p'] })
    $a = @($cur | Where-Object { $_['s'] -eq 'a' } | ForEach-Object { [double]$_['p'] })
    $res.nO = $o.Count; $res.nA = $a.Count
    if ($o.Count -gt 0) { $res.medO = [Math]::Round((Get-Median $o)) }
    if ($a.Count -gt 0) { $res.medA = [Math]::Round((Get-Median $a)) }
    if ($res.n -ge 8 -and $res.kmMatch) { $res.conf = 'high' } elseif ($res.n -ge 4) { $res.conf = 'mid' } else { $res.conf = 'low' }
    $res.comps = @($cur | Select-Object -First 60)
    return $res
}
