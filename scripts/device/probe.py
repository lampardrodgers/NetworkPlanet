#!/usr/bin/env python3
"""Network Planet 单次测试。只读网卡/路由，不安装、不提权、不修改系统设置。
需要现有 Python 3 和系统 ping。测量目标固定为公网 IPv4。
运行：python3 本文件 --server https://你的站点 [--interface en0]
Ctrl+C 终止；没有后台任务或本地输出文件。下载文件可用完后删除。
"""
import argparse, base64, ipaddress, json, os, re, socket, struct, subprocess, sys, time, urllib.request
MANIFEST = '__NP_MANIFEST__'
ENV = {**os.environ, 'LC_ALL': 'C', 'LANG': 'C'}
def command(args, timeout=8):
    r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=ENV, timeout=timeout)
    return r.returncode, r.stdout

def physical_interfaces():
    if sys.platform == 'darwin':
        code, out = command(['/usr/sbin/networksetup', '-listallhardwareports'])
        if code: raise RuntimeError('Cannot inspect physical adapters')
        names = re.findall(r'Device: (en\d+)', out)
        active=[]
        for n in dict.fromkeys(names):
            code, details=command(['/sbin/ifconfig', n])
            if code or 'status: active' not in details:continue
            # 雷雳端口等可能显示 active，但没有可用于本轮 IPv4 测试的地址。
            addresses=[ipaddress.IPv4Address(ip) for ip in re.findall(r'\binet (\d+\.\d+\.\d+\.\d+)\b',details)]
            if any(not (ip.is_link_local or ip.is_loopback or ip.is_unspecified) for ip in addresses):active.append(n)
        return active
    if sys.platform.startswith('linux'):
        root = '/sys/class/net'
        return [n for n in os.listdir(root) if os.path.exists(root+'/'+n+'/device') and open(root+'/'+n+'/operstate').read().strip() == 'up']
    raise RuntimeError('Use the Windows PowerShell script on Windows')

def interface_labels(choices):
    # 这些信息只用于展示；读取失败不改变后续的物理网卡绑定和路由校验。
    names={}
    if sys.platform=='darwin':
        try:
            code,out=command(['/usr/sbin/networksetup','-listallhardwareports'])
            if not code:
                for port,iface in re.findall(r'Hardware Port:\s*([^\n]+)\nDevice:\s*(\S+)',out):
                    if re.search(r'Wi-Fi|AirPort',port,re.I):kind='Wi-Fi（无线网络）'
                    elif re.search(r'Ethernet|\bLAN\b',port,re.I):kind='有线网络（'+port.strip()+'）'
                    elif re.search(r'Thunderbolt',port,re.I):kind='雷雳（'+port.strip()+'）'
                    else:kind=port.strip()
                    names[iface]=kind
        except (OSError,subprocess.SubprocessError):pass
    labels={}
    for iface in choices:
        addresses=[]
        try:
            if sys.platform=='darwin':
                code,out=command(['/sbin/ifconfig',iface])
                if not code:addresses=re.findall(r'\binet (\d+\.\d+\.\d+\.\d+)\b',out)
            elif sys.platform.startswith('linux'):
                if os.path.isdir('/sys/class/net/'+iface+'/wireless'):names[iface]='Wi-Fi（无线网络）'
                code,out=command(['ip','-j','-4','addr','show','dev',iface])
                if not code:addresses=[a['local'] for row in json.loads(out) for a in row.get('addr_info',[]) if a.get('family')=='inet' and a.get('local')]
        except (OSError,subprocess.SubprocessError,ValueError,KeyError):pass
        labels[iface]=names.get(iface,'物理网卡（类型未知）')+' · '+iface+' · IPv4：'+(', '.join(addresses) or '未读取到')
    return labels

def select_interface(requested=None):
    choices=physical_interfaces()
    if requested:
        if requested not in choices:raise RuntimeError('指定的物理网卡不可用：'+requested+'；可用网卡：'+(', '.join(choices) or '无'))
        return requested
    if not choices:raise RuntimeError('没有可用的物理 IPv4 网卡，请检查 Wi-Fi 或网线连接')
    if len(choices)==1:return choices[0]
    if sys.platform=='darwin':
        # 只读取路由。默认路由可能是 utun，不能将其作为测试出口。
        code, out=command(['/sbin/route','-n','get','default'])
        default=re.search(r'interface:\s*(\S+)',out) if not code else None
        routed=[]
        for iface in choices:
            code, out=command(['/sbin/route','-n','get','-ifscope',iface,'default'])
            actual=re.search(r'interface:\s*(\S+)',out)
            gateway=re.search(r'gateway:\s*(\d+\.\d+\.\d+\.\d+)\b',out)
            if not code and actual and actual[1]==iface and gateway and not re.search(r'\b(?:REJECT|BLACKHOLE)\b',out):routed.append(iface)
        if default and default[1] in routed:return default[1]
        if len(routed)==1:return routed[0]
        if not routed:raise RuntimeError('没有可确认的物理 IPv4 默认出口；未启动测试')
        choices=routed
    if not sys.stdin.isatty():
        raise RuntimeError('多个物理出口可用，请在网页的 DIRECT 物理网卡中填写 '+ ' / '.join(choices)+'，然后重新生成命令')
    print('发现多个可用物理出口，请选择本轮使用的网卡（不会修改系统设置）：',flush=True)
    labels=interface_labels(choices)
    for index,iface in enumerate(choices,1):print('  '+str(index)+'. '+labels[iface],flush=True)
    print('要测试 Wi-Fi 就选无线网络；要测试网线就选有线网络。',flush=True)
    while True:
        selected=input('输入编号或网卡名，q 取消：').strip()
        if selected.lower()=='q':raise RuntimeError('用户取消；未启动测试')
        if selected in choices:return selected
        if selected.isdigit() and 1<=int(selected)<=len(choices):return choices[int(selected)-1]
        print('请选择列表中的编号或网卡名。',flush=True)

def check_route(iface, ip):
    if iface not in physical_interfaces(): raise RuntimeError('Physical adapter disconnected; stopped')
    if sys.platform == 'darwin':
        code, out = command(['/sbin/route', '-n', 'get', '-ifscope', iface, ip])
        if code or not re.search(r'interface:\s*'+re.escape(iface)+r'\s', out): raise RuntimeError('No verified physical interface route')
    else:
        code, out = command(['ip', '-j', 'route', 'get', ip, 'oif', iface])
        rows = json.loads(out) if not code else []
        if not rows or rows[0].get('dev') != iface: raise RuntimeError('No verified physical interface route')

def ping_args(iface, ip, ttl=None):
    if sys.platform == 'darwin':
        return ['/sbin/ping','-n','-b',iface,'-c','1','-W','1000','-t','2'] + (['-m',str(ttl)] if ttl else []) + [ip]
    return ['ping','-n','-I',iface,'-c','1','-W','1','-w','2'] + (['-t',str(ttl)] if ttl else []) + [ip]

def linux_raw_ping(iface, ip, ttl=64):
    # For Linux ping variants without -I. Requires existing raw-socket privileges;
    # never requests elevation or installs a replacement ping binary.
    with socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode()+b'\0')
        if sock.getsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,64).rstrip(b'\0').decode()!=iface:
            raise RuntimeError('Raw ICMP interface binding rejected')
        sock.setsockopt(socket.IPPROTO_IP,socket.IP_TTL,ttl)
        ident=int.from_bytes(os.urandom(2),'big');seq=1
        packet=struct.pack('!BBHHH',8,0,0,ident,seq)+b'NP-DIRECT-TEST!\0'
        total=sum(struct.unpack('!'+str(len(packet)//2)+'H',packet))
        total=(total>>16)+(total&65535);total+=(total>>16)
        packet=packet[:2]+struct.pack('!H',(~total)&65535)+packet[4:]
        start=time.monotonic();sock.sendto(packet,(ip,0));deadline=start+1
        while time.monotonic()<deadline:
            sock.settimeout(max(.001,deadline-time.monotonic()))
            try:data,addr=sock.recvfrom(65535)
            except socket.timeout:break
            if len(data)<28:continue
            offset=(data[0]&15)*4;icmp=data[offset:]
            if len(icmp)<8:continue
            if icmp[0]==0 and struct.unpack('!HH',icmp[4:8])==(ident,seq) and addr[0]==ip:
                return addr[0],(time.monotonic()-start)*1000,True
            if icmp[0] in (3,11) and len(icmp)>=36:
                inner=icmp[8:];inner_offset=(inner[0]&15)*4;echo=inner[inner_offset:]
                if len(echo)>=8 and struct.unpack('!HH',echo[4:8])==(ident,seq):
                    return addr[0],None,False
        return '*',None,False

def bind_physical(sock, iface):
    if sys.platform=='darwin':
        idx=socket.if_nametoindex(iface);sock.setsockopt(socket.IPPROTO_IP,25,idx)
        if sock.getsockopt(socket.IPPROTO_IP,25)!=idx:raise RuntimeError('Interface binding rejected')
    else:
        sock.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,iface.encode()+b'\0')
        if sock.getsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,64).rstrip(b'\0').decode()!=iface:raise RuntimeError('Interface binding rejected')

def service_probe(t, iface):
    r={'target':t['id'],'method':t['method'],'samples':[],'interface':iface,'proof':'mac-bound' if sys.platform=='darwin' else 'linux-bound'}
    try:
        check_route(iface,t['ip'])
        with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as sock:
            bind_physical(sock,iface);sock.settimeout(3)
            start=time.monotonic();sock.connect((t['ip'],t['port']))
            if t['method']=='ssh-banner':
                data=b'';deadline=start+3
                while len(data)<4096 and time.monotonic()<deadline:
                    sock.settimeout(max(.001,deadline-time.monotonic()))
                    chunk=sock.recv(min(512,4096-len(data)))
                    if not chunk:break
                    data+=chunk
                    if re.search(br'(?:^|\n)SSH-[12]\.[0-9]-[^\r\n]+[\r\n]',data):break
                else:raise RuntimeError('No SSH banner from backend')
                if not re.search(br'(?:^|\n)SSH-[12]\.[0-9]-[^\r\n]+[\r\n]',data):raise RuntimeError('No SSH banner from backend')
            r['samples']=[(time.monotonic()-start)*1000]
            check_route(iface,t['ip'])
    except Exception as e:r.update(error=str(e)[:300],samples=[])
    print(t['name']+' ['+t['method']+']: '+(r.get('error') or str(round(r['samples'][0],1))+' ms'),flush=True)
    return r

def probe_summary(t, r):
    if r.get('error'):return t['name']+': '+r['error']
    parts=[]
    if t.get('latency',True):
        samples=r.get('samples',[])
        parts.append('Ping '+str(round(sum(samples)/len(samples),1))+' ms' if samples else 'Ping 未收到回包（0/3）；不代表节点离线')
    if 'trace' in r:
        hops=[line.split() for line in r['trace'].splitlines() if len(line.split())>=2]
        visible=sum(hop[1]!='*' for hop in hops)
        reached=any(hop[1]==t['ip'] for hop in hops)
        parts.append('线路 '+str(len(hops))+' 跳，'+str(visible)+' 跳有响应，'+('已到达目标' if reached else '未确认到达目标'))
    return t['name']+': '+'；'.join(parts)

def probe(t, iface, trace):
    ip = str(ipaddress.IPv4Address(t['ip']))
    if not ipaddress.ip_address(ip).is_global: raise RuntimeError('Refusing non-public target')
    if t.get('method','icmp')!='icmp':return service_probe(t,iface)
    r = {'target':t['id'],'method':'icmp','samples':[], 'interface':iface, 'proof':'mac-bound' if sys.platform=='darwin' else 'linux-bound'}
    try:
        # Verify that the OS supports binding this physical device. Never fall back to an unbound probe.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            if sys.platform=='darwin':
                idx=socket.if_nametoindex(iface);s.setsockopt(socket.IPPROTO_IP,25,idx)
                if s.getsockopt(socket.IPPROTO_IP,25)!=idx: raise RuntimeError('Interface binding rejected')
            else:
                s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,iface.encode()+b'\0')
                if s.getsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,64).rstrip(b'\0').decode()!=iface: raise RuntimeError('Interface binding rejected')
        use_raw=sys.platform.startswith('linux') and not re.search(r'(?<!\w)-I(?:[ ,]|$)|--interface',command(['ping','-h'])[1])
        if use_raw:
            for _ in range(3 if t.get('latency',True) else 0):
                check_route(iface,ip)
                _,ms,_=linux_raw_ping(iface,ip)
                if ms is not None:r['samples'].append(ms)
            if trace:
                hops=[]
                for ttl in range(1,31):
                    check_route(iface,ip)
                    hop,_,reached=linux_raw_ping(iface,ip,ttl);hops.append(str(ttl)+' '+hop)
                    if reached:break
                r['trace']='\n'.join(hops)
            print(probe_summary(t,r),flush=True)
            return r
        for _ in range(3 if t.get('latency',True) else 0):
            check_route(iface,ip)
            code,out=command(ping_args(iface,ip),4)
            if code not in (0,1,2) or re.search(r'not permitted|permission denied|invalid option|illegal option|bind.*fail',out,re.I): raise RuntimeError('Native bound ping unavailable: '+out[:180])
            m=re.search(r'time[=<]([\d.]+)\s*ms',out)
            if m:r['samples'].append(float(m[1]))
        if trace:
            hops=[]
            for ttl in range(1,31):
                check_route(iface,ip)
                code,out=command(ping_args(iface,ip,ttl),4)
                if re.search(r'not permitted|permission denied|invalid option|illegal option|bind.*fail',out,re.I):raise RuntimeError('Bound route probe rejected')
                reply=re.search(r'(?:bytes from|[Ff]rom)\s+(\d+\.\d+\.\d+\.\d+)',out)
                reached=bool(re.search(r'time[=<][\d.]+\s*ms',out))
                # macOS TTL-exceeded replies may be printed as "IP: Time to live exceeded".
                if not reply:reply=re.search(r'(\d+\.\d+\.\d+\.\d+):?\s+Time to live exceeded',out,re.I)
                hop=reply[1] if reply else '*';hops.append(str(ttl)+' '+hop)
                if reached and hop==ip:break
            r['trace']='\n'.join(hops)
    except Exception as e:
        r.update(error=str(e)[:300],samples=[],trace='')
    print(probe_summary(t,r),flush=True)
    return r

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--server',required=True);ap.add_argument('--interface');args=ap.parse_args()
    from urllib.parse import urlsplit
    url=urlsplit(args.server)
    if (url.scheme!='https' and not (url.scheme=='http' and url.hostname in ('localhost','127.0.0.1'))) or url.username or url.password or url.path not in ('','/') or url.query or url.fragment:raise RuntimeError('HTTPS site origin required')
    job=json.loads(base64.b64decode(MANIFEST));result={'id':job['id'],'token':job['token'],'results':[]}
    if time.time()*1000>job['expiresAt']:raise RuntimeError('Task expired; generate a new script')
    try:
        iface=select_interface(args.interface or job.get('directInterface'))
        print('测试模式：'+('仅线路分析（不测 Ping 延迟）' if job.get('kind')=='route' else '延迟 + 线路分析' if job['trace'] else '延迟测试'),flush=True)
        print('DIRECT physical interface: '+interface_labels([iface])[iface]+'; no proxy/route/settings changes. Ctrl+C to stop.',flush=True)
        # Sequential execution keeps cancellation immediate and probe traffic bounded.
        for target in job['targets']:result['results'].append(probe(target,iface,job['trace']))
    except KeyboardInterrupt:result['error']='Cancelled by user'
    except Exception as e:result['error']=str(e)[:300];print('STOP: '+result['error'])
    # Upload is HTTPS control traffic, not a network measurement. Proxies are disabled here too.
    request=urllib.request.Request(args.server.rstrip('/')+'/api/device-tests/upload',data=json.dumps(result).encode(),headers={'Content-Type':'application/json'},method='POST')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request,timeout=20) as response:
        if response.status!=200:raise RuntimeError('Upload failed')
    print(('未执行节点测试；已上传停止原因。' if result.get('error') and not result['results'] else 'Results uploaded.')+' Exiting; no background process remains.')
if __name__=='__main__':
    try:main()
    except Exception as e:print('Stopped: '+str(e),file=sys.stderr);sys.exit(1)
