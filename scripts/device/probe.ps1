# Network Planet one-shot test. No install, elevation, route or policy changes.
# Run in Windows PowerShell: .\netplanet-xxxxxxxx.ps1 -Server https://your-site
param([Parameter(Mandatory=$true)][string]$Server, [int]$InterfaceIndex=0)
$ErrorActionPreference='Stop'
$manifest='__NP_MANIFEST__'
$job=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($manifest)) | ConvertFrom-Json
$uri=[Uri]$Server
if (($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { throw 'HTTPS site origin required' }
if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt $job.expiresAt) { throw 'Task expired; generate a new script' }
if (-not $InterfaceIndex -and $job.directInterface) {
 $selected=@(Get-NetAdapter -Name $job.directInterface -ErrorAction Stop); if($selected.Count -ne 1){throw 'Select one physical adapter'}; $InterfaceIndex=$selected[0].InterfaceIndex
}
$result=@{id=$job.id; token=$job.token; results=@()}
function Get-DirectAdapter([string]$ip) {
    # Fail closed when a VPN/TUN/virtual adapter is active. No attempt to change it.
    $up=@(Get-NetAdapter -IncludeHidden | Where-Object { $_.Status -eq 'Up' })
    if (@($up | Where-Object { -not $_.HardwareInterface }).Count) { throw 'An active virtual/VPN adapter exists. DIRECT cannot be confirmed; no tests were sent.' }
    $route=@(Find-NetRoute -RemoteIPAddress $ip | Where-Object { $_.DestinationPrefix })
    if ($route.Count -ne 1) { throw 'Cannot determine one IPv4 route' }
    $adapter=@($up | Where-Object { $_.InterfaceIndex -eq $route[0].InterfaceIndex -and $_.HardwareInterface })
    if ($adapter.Count -ne 1 -or ($InterfaceIndex -and $adapter[0].InterfaceIndex -ne $InterfaceIndex)) { throw 'The route does not use the selected physical adapter' }
    return $adapter[0]
}
function Invoke-ServiceProbe($target) {
 $r=@{target=$target.id;method=$target.method;samples=@();proof='windows-physical-route';interface=''}
 $socket=$null
 try {
  $adapter=Get-DirectAdapter $target.ip;$r.interface=$adapter.Name
  $addresses=@(Get-NetIPAddress -InterfaceIndex $adapter.InterfaceIndex -AddressFamily IPv4 | Where-Object { $_.AddressState -eq 'Preferred' -and -not $_.SkipAsSource })
  if($addresses.Count -ne 1){throw 'Cannot confirm a single physical IPv4 source'}
  $socket=[Net.Sockets.Socket]::new([Net.Sockets.AddressFamily]::InterNetwork,[Net.Sockets.SocketType]::Stream,[Net.Sockets.ProtocolType]::Tcp)
  $socket.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Parse($addresses[0].IPAddress),0))
  $socket.SetSocketOption([Net.Sockets.SocketOptionLevel]::IP,[Net.Sockets.SocketOptionName]31,[Net.IPAddress]::HostToNetworkOrder([int]$adapter.InterfaceIndex))
  $watch=[Diagnostics.Stopwatch]::StartNew()
  $connect=$socket.ConnectAsync([Net.IPAddress]::Parse($target.ip),[int]$target.port)
  if(-not $connect.Wait(3000)){throw 'TCP connection timeout'}
  if($target.method -eq 'ssh-banner'){
   $text='';$buffer=New-Object byte[] 512
   while($text.Length -lt 4096 -and $watch.ElapsedMilliseconds -lt 3000){
    $socket.ReceiveTimeout=[Math]::Max(1,3000-[int]$watch.ElapsedMilliseconds)
    $n=$socket.Receive($buffer);if($n -eq 0){break};$text+=[Text.Encoding]::ASCII.GetString($buffer,0,$n)
    if($text -match '(?m)^SSH-[12]\.[0-9]-[^\r\n]+[\r\n]'){break}
   }
   if($text -notmatch '(?m)^SSH-[12]\.[0-9]-[^\r\n]+[\r\n]'){throw 'No SSH banner from backend'}
  }
  $r.samples=@($watch.Elapsed.TotalMilliseconds)
  if((Get-DirectAdapter $target.ip).InterfaceIndex -ne $adapter.InterfaceIndex){throw 'Physical route changed'}
 } catch {$r.error=$_.Exception.Message;$r.samples=@()} finally {if($socket){$socket.Dispose()}}
 return $r
}
Write-Host $(if($job.kind -eq 'route'){'测试模式：仅线路分析（不测 Ping 延迟）'}elseif($job.trace){'测试模式：延迟 + 线路分析'}else{'测试模式：延迟测试'})
$ping=New-Object System.Net.NetworkInformation.Ping
try {
    foreach ($target in $job.targets) {
        if($target.method -and $target.method -ne 'icmp') {
         $service=Invoke-ServiceProbe $target;$result.results+=$service;Write-Host ($target.name+' ['+$target.method+']: '+$(if($service.error){$service.error}else{'completed'}));continue
        }
        $r=@{target=$target.id; method='icmp'; samples=@(); proof='windows-physical-route'; interface=''}
        try {
            $ip=[Net.IPAddress]::Parse($target.ip)
            if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'IPv4 required' }
            $adapter=Get-DirectAdapter $target.ip; $r.interface=$adapter.Name
            $count=3;if($target.latency -eq $false){$count=0}
            for ($i=0;$i -lt $count;$i++) {
                $current=Get-DirectAdapter $target.ip
                if ($current.InterfaceIndex -ne $adapter.InterfaceIndex) { throw 'Physical route changed; stopped' }
                $reply=$ping.Send($ip,1000,([byte[]](0..15)),(New-Object Net.NetworkInformation.PingOptions(64,$true)))
                if ($reply.Status -eq 'Success') { $r.samples+= [double]$reply.RoundtripTime }
            }
            if ($job.trace) {
                $hops=@()
                foreach ($ttl in 1..30) {
                    $current=Get-DirectAdapter $target.ip
                    if ($current.InterfaceIndex -ne $adapter.InterfaceIndex) { throw 'Physical route changed; stopped' }
                    $reply=$ping.Send($ip,1000,([byte[]](0..15)),(New-Object Net.NetworkInformation.PingOptions($ttl,$true)))
                    $hop='*'
                    if ($reply.Status -in @('Success','TtlExpired') -and $reply.Address) { $hop=$reply.Address.ToString() }
                    $hops+="$ttl $hop"
                    if ($reply.Status -eq 'Success') { break }
                }
                $r.trace=$hops -join "`n"
            }
        } catch { $r.error=$_.Exception.Message; $r.samples=@(); $r.trace='' }
        $result.results+=$r
        $summary=if($r.error){$r.error}elseif($target.latency -eq $false){''}elseif($r.samples.Count){'Ping '+([Math]::Round(($r.samples|Measure-Object -Average).Average,1)).ToString()+' ms'}else{'Ping 未收到回包（0/3）；不代表节点离线'}
        if(-not $r.error -and $r.ContainsKey('trace')){
         $hops=@($r.trace -split "`n" | Where-Object {$_ -match '^\d+ '})
         $visible=@($hops | Where-Object {($_ -split ' ')[1] -ne '*'}).Count
         $reached=@($hops | Where-Object {($_ -split ' ')[1] -eq $target.ip}).Count -gt 0
         if($summary){$summary+='；'}
         $summary+='线路 '+$hops.Count+' 跳，'+$visible+' 跳有响应，'+$(if($reached){'已到达目标'}else{'未确认到达目标'})
        }
        Write-Host ($target.name+': '+$summary)
    }
} finally { $ping.Dispose() }
# Upload is control traffic. It is never counted as a measurement.
Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$handler=New-Object Net.Http.HttpClientHandler; $handler.UseProxy=$false
$client=New-Object Net.Http.HttpClient($handler); $client.Timeout=[TimeSpan]::FromSeconds(20)
$content=New-Object Net.Http.StringContent(($result | ConvertTo-Json -Depth 10),[Text.Encoding]::UTF8,'application/json')
try {
    $response=$client.PostAsync($Server.TrimEnd('/')+'/api/device-tests/upload',$content).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    Write-Host 'Results uploaded. Exiting; no background process remains.'
} finally { $content.Dispose(); $client.Dispose(); $handler.Dispose() }
