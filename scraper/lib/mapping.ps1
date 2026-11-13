# Maps Japanese auction names (maker / model) to Otomoto and Autoplac catalog entries. ASCII only.

$script:MakerMap = @{
    'MERCEDES BENZ' = 'mercedes-benz'; 'MERCEDES AMG' = 'mercedes-benz'; 'AMG' = 'mercedes-benz'; 'MERCEDES MAYBACH' = 'mercedes-benz'
    'AMERICA TOYOTA' = 'toyota'; 'AMERICA HONDA' = 'honda'; 'AMERICA NISSAN' = 'nissan'; 'AMERICA MITSUBISHI' = 'mitsubishi'
    'AMERICA MAZDA' = 'mazda'; 'AMERICA SUBARU' = 'subaru'; 'AMERICA LEXUS' = 'lexus'
    'BMW ALPINA' = 'alpina'; 'CHRYSLER JEEP' = 'jeep'; 'ROLLS-ROYCE' = 'rolls-royce'; 'ROLLS ROYCE' = 'rolls-royce'
    'ALFA ROMEO' = 'alfa-romeo'; 'LAND ROVER' = 'land-rover'; 'ASTON MARTIN' = 'aston-martin'; 'BMW MINI' = 'mini'
    'MERCEDES BENZ SMART' = 'smart'; 'MCC SMART' = 'smart'
}

# Maker shown in the brand filter (AMG and Maybach are folded into Mercedes-Benz).
$script:BrandDisplay = @{
    'mercedes-benz' = 'Mercedes-Benz'; 'bmw' = 'BMW'; 'alpina' = 'BMW Alpina'; 'gmc' = 'GMC'; 'rolls-royce' = 'Rolls-Royce'
    'alfa-romeo' = 'Alfa Romeo'; 'land-rover' = 'Land Rover'; 'aston-martin' = 'Aston Martin'; 'mini' = 'MINI'; 'ds-automobiles' = 'DS'
}

$script:PremiumWords = @('GT3 RS', 'GT3', 'GT2', 'TURBO S', 'BLACK SERIES', 'HELLCAT', 'DEMON', 'TRACKHAWK', 'SHELBY', 'Z06', 'ZR1', 'SVR', 'SPEEDSTER', 'COMPETITION', 'RAPTOR', 'SRT', 'GTS', 'TARGA', 'TURBO')

function Get-Norm([string]$s) { if (-not $s) { return '' }; return (($s.ToLower()) -replace '[^a-z0-9]', '') }

function Get-MakeId([string]$maker) {
    $m = $maker.Trim().ToUpper()
    if ($script:MakerMap.ContainsKey($m)) { return $script:MakerMap[$m] }
    return (($m.ToLower()) -replace '[^a-z0-9]+', '-').Trim('-')
}

function Get-BrandName([string]$maker, $cat) {
    $id = Get-MakeId $maker
    if ($script:BrandDisplay.ContainsKey($id)) { return $script:BrandDisplay[$id] }
    if ($cat -and $cat.ContainsKey($id)) { return [string]$cat[$id]['name'] }
    $t = (Get-Culture).TextInfo.ToTitleCase($maker.ToLower())
    return $t
}

function Get-ModelTokens([string]$model) {
    $tok = @($model.ToUpper() -split '\s+' | Where-Object { $_ })
    $out = @()
    for ($i = 0; $i -lt $tok.Count; $i++) {
        if ($i -gt 0 -and ($script:BodyTokens -contains $tok[$i])) { continue }
        $out += $tok[$i]
    }
    return , $out
}

function Find-ModelById($models, [string]$id) {
    foreach ($m in $models) { if ($m['id'] -eq $id) { return $m } }
    return $null
}

# Returns @{ make; makeName; model; modelName } or $null when the car cannot be matched.
function Resolve-OtomotoModel($car, $cat) {
    $mk = Get-MakeId $car.maker
    if (-not $cat.ContainsKey($mk)) { return $null }
    $entry = $cat[$mk]
    $models = @($entry['models'] | Where-Object { $_['id'] -ne 'other' })
    $tok = Get-ModelTokens $car.model
    if ($tok.Count -eq 0 -or $tok[0] -eq 'OTHERS') { return $null }
    $hit = $null
    $makerUp = $car.maker.ToUpper()

    if ($mk -eq 'mercedes-benz') {
        $letter = ''
        if ($tok[0] -match '^([A-Z0-9]+)-CLASS$') { $letter = $Matches[1] }
        elseif ($tok.Count -gt 1 -and $tok[1] -eq 'CLASS') { $letter = $tok[0] }
        else { $letter = $tok[0] }
        $id = ''
        if ($makerUp -eq 'MERCEDES MAYBACH') {
            if ($letter -eq 'S') { $id = 'maybach-s680' } elseif ($letter -eq 'GLS') { $id = 'maybach-gls' } elseif ($letter -eq 'SL') { $id = 'maybach-sl-680' }
        }
        if (-not $id) {
            switch -Regex ($letter) {
                '^(A|B|C|E|G|R|S|V)$' { $id = 'klasa-' + $letter.ToLower(); break }
                '^X$' { $id = 'x-klasa'; break }
                '^T$' { $id = 't-klasa'; break }
                '^M$' { $id = 'ml'; break }
                '^MEDIUM$' { $id = 'w124-1984-1993'; break }
                '^190$' { $id = 'w201-190'; break }
                '^GT$' { $id = 'amg-gt'; break }
                default { $id = $letter.ToLower() }
            }
        }
        $hit = Find-ModelById $models $id
    }
    elseif ($mk -eq 'bmw' -and $tok.Count -gt 1 -and $tok[1] -eq 'SERIES' -and $tok[0] -match '^\d$') {
        $hit = Find-ModelById $models ('seria-' + $tok[0])
    }

    if (-not $hit -and $mk -ne 'mercedes-benz') {
        # longest run of leading tokens that equals a catalog model name
        for ($k = [Math]::Min($tok.Count, 3); $k -ge 1 -and -not $hit; $k--) {
            $n = Get-Norm ($tok[0..($k - 1)] -join '')
            foreach ($m in $models) {
                if ((Get-Norm $m['name']) -eq $n -or (Get-Norm $m['id']) -eq $n) { $hit = $m; break }
            }
        }
        if (-not $hit) {
            $n = Get-Norm $tok[0]
            if ($n.Length -ge 3) {
                $cands = @($models | Where-Object { (Get-Norm $_['name']).StartsWith($n) } | Sort-Object { ([string]$_['name']).Length })
                if ($cands.Count -gt 0) { $hit = $cands[0] }
            }
        }
    }
    if (-not $hit) { return $null }
    return @{ make = $mk; makeName = [string]$entry['name']; model = [string]$hit['id']; modelName = [string]$hit['name'] }
}

# Autoplac ids ("brandId_modelId") for the same model; Autoplac splits some models (911 / 911 Carrera).
function Resolve-AutoplacIds($oto, $dict) {
    if (-not $oto -or -not $dict) { return @() }
    $bn = Get-Norm $oto.makeName
    $brand = $null
    foreach ($b in $dict) { if ((Get-Norm $b['displayName']) -eq $bn) { $brand = $b; break } }
    if (-not $brand) {
        foreach ($b in $dict) { $x = Get-Norm $b['displayName']; if ($x.Length -ge 3 -and ($bn.Contains($x) -or $x.Contains($bn))) { $brand = $b; break } }
    }
    if (-not $brand) { return @() }
    $want = Get-Norm $oto.modelName
    $wantTok = @($oto.modelName.ToLower() -split '[^a-z0-9]+' | Where-Object { $_ })
    $exact = @(); $partial = @()
    foreach ($m in @($brand['models'])) {
        if ([int]$m['value'] -lt 0) { continue }
        $name = [string]$m['displayName']
        if ((Get-Norm $name) -eq $want) { $exact += $m; continue }
        $tk = @($name.ToLower() -split '[^a-z0-9]+' | Where-Object { $_ })
        $all = $true
        foreach ($w in $wantTok) { if ($tk -notcontains $w) { $all = $false; break } }
        if ($all -and $wantTok.Count -gt 0) { $partial += $m }
    }
    $pick = @($exact) + @($partial) | Select-Object -First 4
    return @($pick | ForEach-Object { "$($brand['value'])_$($_['value'])" })
}

# A token that identifies the version, e.g. S580, G63, CLS350, 325I - used to compare like with like.
function Get-GradeToken($car) {
    $g = ([string]$car.grade).ToUpper()
    if (-not $g) { return '' }
    foreach ($t in ($g -split '[\s/]+')) {
        if ($t -match '^[A-Z]{0,4}\d{2,3}[A-Z]{0,2}$' -and $t -notmatch '^\d{4}$') { return $t }
    }
    return ''
}

function Get-PremiumWord($car) {
    $g = (' ' + ([string]$car.grade).ToUpper() + ' ' + ([string]$car.model).ToUpper() + ' ')
    foreach ($w in $script:PremiumWords) { if ($g.Contains(' ' + $w + ' ')) { return $w } }
    return ''
}
