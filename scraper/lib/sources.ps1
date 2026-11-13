# Auction sources: RajAuto (CSV feed) and Fabryka Klasykow (HTML list). ASCII only.

$script:RajBase = 'https://aukcje.samochodyzjaponi.pl'
$script:FabBase = 'https://aukcje.fabrykaklasykow.eu'

$script:BodyTokens = @('2D','3D','4D','5D','CP','OP','4WD','2WD','WG','STATIONWAGON','WAGON','COUPE','CABRIOLET','CONVERTIBLE','CROSSOVER','SEDAN','HB','VAN')

function ConvertTo-IsoDate([string]$d) {
    if ($d -match '(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})') { return ('{0}-{1:00}-{2:00}' -f $Matches[1], [int]$Matches[2], [int]$Matches[3]) }
    return ''
}

# Full-width Japanese characters -> plain ASCII; anything still non-ASCII is dropped.
function Get-Clean([string]$s) {
    if (-not $s) { return '' }
    $n = $s.Normalize([Text.NormalizationForm]::FormKC)
    return (($n -replace '[^\x20-\x7E]', '') -replace '\s+', ' ').Trim()
}

function New-CarId([string]$isoDate, [string]$lot) { return (($isoDate -replace '-', '') + '-' + ($lot -replace '[^\w]', '')) }

function Get-RajAutoCars {
    $csv = Get-Url "$($script:RajBase)/api/get-car-data"
    $list = New-Object System.Collections.Generic.List[object]
    if (-not $csv) { Write-Host 'RajAuto: no data'; return $list }
    $rows = $csv | ConvertFrom-Csv
    foreach ($r in $rows) {
        $lot = ([string]$r.bid_no).Trim()
        $date = ConvertTo-IsoDate $r.bidding_date
        if (-not $lot -or -not $date) { continue }
        $equip = @()
        foreach ($p in $r.PSObject.Properties) { if ($p.Name -like 'eq_*' -and $p.Value) { $equip += [string]$p.Value } }
        $img = "$($script:RajBase)/static/images/$lot"
        $grade = Get-Clean ([string]$r.type)
        if ($grade -eq 'OTHERS' -or $grade -eq 'BASE GRADE') { $gradeClean = '' } else { $gradeClean = $grade }
        $list.Add(@{
            id = New-CarId $date $lot
            lot = $lot; date = $date; site = Get-Clean ([string]$r.site)
            maker = (Get-Clean ([string]$r.maker)).ToUpper()
            model = (Get-Clean ([string]$r.model_grade)).ToUpper()
            grade = $gradeClean.ToUpper()
            year = [int](ConvertTo-Int $r.model_year)
            km = [int](ConvertTo-Int $r.mileage)
            cc = [int](ConvertTo-Int $r.displacement)
            trans = ([string]$r.transmission).Trim()
            score = ([string]$r.inspection_score).Trim()
            startJpy = [int64](ConvertTo-Int $r.start_price)
            result = ([string]$r.bid_result).Trim()
            color = [string]$r.detail_body_color
            body = [string]$r.detail_body_type
            steering = [string]$r.detail_steering_wheel
            ac = [string]$r.detail_air_conditioner
            inspection = [string]$r.detail_japan_safety_inspection
            chassis = Get-Clean ([string]$r.detail_type)
            equip = $equip
            photos = @("$img/${lot}_main_photo.jpg", "$img/${lot}_gallery_2.jpg", "$img/${lot}_gallery_3.jpg", "$img/${lot}_gallery_4.jpg", "$img/${lot}_gallery_5.jpg")
            sheet = "$img/${lot}_sheet.jpg"
            urls = @{ rajauto = "$($script:RajBase)/auto/$lot" }
            src = @('rajauto')
        })
    }
    Write-Host "RajAuto: $($list.Count) auctions"
    return $list
}

# Splits "MERCEDES BENZ S-CLASS 4D 4WD S580 4MATIC LONG" into maker / model / grade.
function Split-FabrykaTitle([string]$title, $makers, $modelsByMaker) {
    $t = (Get-Clean $title).ToUpper()
    $maker = ''
    foreach ($m in $makers) { if ($t -eq $m -or $t.StartsWith($m + ' ')) { $maker = $m; break } }
    if (-not $maker) {
        $parts = $t -split '\s+', 2
        $maker = $parts[0]
    }
    $rest = $t.Substring($maker.Length).Trim()
    $model = ''
    $known = $modelsByMaker[$maker]
    if ($known) {
        foreach ($k in $known) { if ($rest -eq $k -or $rest.StartsWith($k + ' ')) { $model = $k; break } }
    }
    if (-not $model) {
        $tok = @($rest -split '\s+' | Where-Object { $_ })
        if ($tok.Count -gt 0) {
            $n = 1
            # "3 SERIES", "E-CLASS", then any body tokens that follow
            if ($tok.Count -gt 1 -and ($tok[1] -eq 'SERIES' -or $tok[1] -eq 'CLASS')) { $n = 2 }
            while ($n -lt $tok.Count -and ($script:BodyTokens -contains $tok[$n])) { $n++ }
            $model = ($tok[0..($n - 1)] -join ' ')
        }
    }
    $grade = $rest.Substring([Math]::Min($rest.Length, $model.Length)).Trim()
    if ($grade -eq 'OTHERS' -or $grade -eq 'BASE GRADE') { $grade = '' }
    return @{ maker = $maker; model = $model; grade = $grade }
}

function Get-FabrykaCars($makers, $modelsByMaker, [int]$MaxPages) {
    $list = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    for ($page = 1; $page -le $MaxPages; $page++) {
        $html = Get-Url "$($script:FabBase)/?pageNumber=$page"
        if (-not $html) { break }
        $chunks = $html -split '<!-- Item-->'
        $new = 0
        foreach ($ch in $chunks) {
            $mj = [regex]::Match($ch, 'data-fk-car="([^"]+)"')
            if (-not $mj.Success) { continue }
            $info = $null
            try { $info = ConvertFrom-JsonDict ([System.Net.WebUtility]::HtmlDecode($mj.Groups[1].Value)) } catch { continue }
            $lot = [string]$info['bid']
            $mp = [regex]::Match($ch, 'JPY\s*([\d,]+)\s*-\s*(\d{4}/\d{1,2}/\d{1,2})')
            if (-not $lot -or -not $mp.Success) { continue }
            $date = ConvertTo-IsoDate $mp.Groups[2].Value
            $id = New-CarId $date $lot
            if ($seen[$id]) { continue }
            $seen[$id] = $true; $new++
            $score = [regex]::Match($ch, 'Ocena:\s*([^<\s]*)').Groups[1].Value
            $site = Get-Clean ([System.Net.WebUtility]::HtmlDecode([regex]::Match($ch, 'fi-map-pin[^>]*></i>\s*([^<]+)<').Groups[1].Value))
            $spans = [regex]::Matches($ch, '<span class="fs-xs text-light">([^<]*)</span>')
            $km = 0; $trans = ''; $cc = 0
            if ($spans.Count -ge 3) {
                $km = [int](ConvertTo-Int $spans[0].Groups[1].Value)
                $trans = $spans[1].Groups[1].Value.Trim()
                $cc = [int](ConvertTo-Int $spans[2].Groups[1].Value)
            }
            $sp = Split-FabrykaTitle ([string]$info['title']) $makers $modelsByMaker
            $img = [string]$info['img']
            $list.Add(@{
                id = $id; lot = $lot; date = $date; site = $site
                maker = $sp.maker; model = $sp.model; grade = $sp.grade
                year = [int](ConvertTo-Int $info['year'])
                km = $km; cc = $cc; trans = $trans; score = $score
                startJpy = [int64](ConvertTo-Int $mp.Groups[1].Value)
                result = ''
                color = ''; body = ''; steering = ''; ac = ''; inspection = ''; chassis = ''
                equip = @()
                photos = @($img)
                sheet = ''
                urls = @{ fabryka = ($script:FabBase + [string]$info['uri']) }
                src = @('fabryka')
            })
        }
        Write-Host "Fabryka: page $page, new $new"
        if ($new -eq 0) { break }
    }
    Write-Host "Fabryka: $($list.Count) auctions"
    return $list
}

# Reads gallery + specification from a Fabryka detail page (used for cars RajAuto does not list).
function Get-FabrykaDetail([string]$Url) {
    $html = Get-Url $Url
    if (-not $html) { return $null }
    $photos = New-Object System.Collections.Generic.List[string]
    foreach ($m in [regex]::Matches($html, 'https://img\.fabrykaklasykow\.eu/[^"''\s)]+\.(?:jpg|jpeg|png|webp)')) {
        if (-not $photos.Contains($m.Value)) { $photos.Add($m.Value) }
    }
    $text = [System.Net.WebUtility]::HtmlDecode(($html -replace '(?s)<script.*?</script>', ' ' -replace '(?s)<style.*?</style>', ' ' -replace '<[^>]+>', ' ' -replace '\s+', ' '))
    $d = @{ photos = @($photos); color = ''; body = ''; steering = ''; ac = ''; inspection = ''; chassis = ''; equip = @() }
    $labels = 'Body color|Body type|Steering wheel|Transmission|Displacement|Type|Japan safety inspection|Mileage|Import classification|Air conditioner'
    $map = @{ 'Body color' = 'color'; 'Body type' = 'body'; 'Steering wheel' = 'steering'; 'Air conditioner' = 'ac'; 'Japan safety inspection' = 'inspection'; 'Type' = 'chassis' }
    foreach ($k in $map.Keys) {
        $m = [regex]::Match($text, "\b${k}:\s*(.*?)\s*(?=(?:$labels):|Wyposa|Dodano:|$)")
        if ($m.Success) { $d[$map[$k]] = $m.Groups[1].Value.Trim() }
    }
    $me = [regex]::Match($text, 'Wyposa\S+:\s*(.*?)\s*Dodano:')
    if ($me.Success) {
        $eq = @()
        foreach ($name in 'Aluminum wheels', 'Leather seat', 'Navigation system', 'Power steering', 'Power window', 'Sunroof') {
            if ($me.Groups[1].Value -match [regex]::Escape($name)) { $eq += $name }
        }
        $d.equip = $eq
    }
    return $d
}

# Merges both sources so each auction (same lot + same auction day + same maker) appears once.
function Merge-Cars($raj, $fab) {
    $byId = [ordered]@{}
    foreach ($c in $raj) { if (-not $byId.Contains($c.id)) { $byId[$c.id] = $c } }
    $merged = 0
    foreach ($f in $fab) {
        if ($byId.Contains($f.id)) {
            $r = $byId[$f.id]
            $sameMaker = ($r.maker -eq $f.maker) -or ($r.maker.Split(' ')[0] -eq $f.maker.Split(' ')[0])
            if ($sameMaker -and ($r.year -eq $f.year -or $r.year -eq 0 -or $f.year -eq 0)) {
                $merged++
                $r.urls['fabryka'] = $f.urls['fabryka']
                $r.src = @('rajauto', 'fabryka')
                if (-not $r.grade -and $f.grade) { $r.grade = $f.grade }
                if ($r.startJpy -le 0 -and $f.startJpy -gt 0) { $r.startJpy = $f.startJpy }
                if (-not $r.site) { $r.site = $f.site }
                $r.photos = @($r.photos) + @($f.photos)
                continue
            }
            $f.id = $f.id + 'f'
        }
        $byId[$f.id] = $f
    }
    Write-Host "Merged duplicates: $merged; unique auctions: $($byId.Count)"
    return $byId
}
