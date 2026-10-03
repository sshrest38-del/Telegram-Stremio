param(
    [Parameter(Mandatory=$true)]
    [string]$Url
)

Write-Host "======================================================================"
Write-Host "Running HTTP Byte-Range Test Suite on Windows against:"
Write-Host "$Url"
Write-Host "======================================================================"

$passed = 0
$failed = 0

function Test-RangeCase {
    param(
        [string]$Name,
        [int]$ExpectedStatus,
        [string]$ExpectedCrSubstring,
        [int]$ExpectedBytes,
        [string]$RangeHeader
    )

    Write-Host -NoNewline "Running: $Name ... "

    try {
        $headers = @{}
        if ($RangeHeader) {
            $headers["Range"] = $RangeHeader
        }

        $res = Invoke-WebRequest -Uri $Url -Headers $headers -Method Get -SkipHttpErrorCheck

        $statusMatch = ($res.StatusCode -eq $ExpectedStatus)
        $crHeader = $res.Headers["Content-Range"]
        $crMatch = ($null -eq $ExpectedCrSubstring) -or ($crHeader -like "*$ExpectedCrSubstring*")
        $bytesCount = $res.RawContentLength
        if ($bytesCount -le 0 -and $res.Content) {
            $bytesCount = $res.Content.Length
        }
        $bytesMatch = ($ExpectedBytes -lt 0) -or ($bytesCount -eq $ExpectedBytes)

        if ($statusMatch -and $crMatch -and $bytesMatch) {
            Write-Host "PASS (HTTP $($res.StatusCode), Bytes: $bytesCount)" -ForegroundColor Green
            $script:passed++
        } else {
            Write-Host "FAIL (Expected HTTP $ExpectedStatus got $($res.StatusCode); Content-Range: $crHeader)" -ForegroundColor Red
            $script:failed++
        }
    } catch {
        Write-Host "ERROR: $_" -ForegroundColor Red
        $script:failed++
    }
}

Test-RangeCase -Name "FIRST 1 MiB" -ExpectedStatus 206 -ExpectedCrSubstring "0-1048575" -ExpectedBytes 1048576 -RangeHeader "bytes=0-1048575"
Test-RangeCase -Name "MIDDLE 1 MiB" -ExpectedStatus 206 -ExpectedCrSubstring "1073741824-1074790399" -ExpectedBytes 1048576 -RangeHeader "bytes=1073741824-1074790399"
Test-RangeCase -Name "SUFFIX RANGE" -ExpectedStatus 206 -ExpectedCrSubstring "" -ExpectedBytes 1048576 -RangeHeader "bytes=-1048576"
Test-RangeCase -Name "INVALID RANGE (416)" -ExpectedStatus 416 -ExpectedCrSubstring "*/" -ExpectedBytes 0 -RangeHeader "bytes=999999999999999-"

Write-Host "======================================================================"
Write-Host "Results: $passed Passed, $failed Failed"
Write-Host "======================================================================"
