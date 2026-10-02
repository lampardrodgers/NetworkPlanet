#!/usr/bin/env python3
"""本机物理网卡绑定 TCP。无 HTTP/SOCKS 代理，无远端文件。"""
import sys, socket, json, time, selectors, ipaddress

def bound_socket(iface, host, port):
    ip = ipaddress.ip_address(host)
    if ip.version != 4:
        raise ValueError('网卡绑定暂只支持 IPv4')
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if sys.platform == 'darwin':
        idx = socket.if_nametoindex(iface)
        sock.setsockopt(socket.IPPROTO_IP, 25, idx)  # Darwin IP_BOUND_IF
        if sock.getsockopt(socket.IPPROTO_IP, 25) != idx:
            raise RuntimeError('物理网卡绑定失败')
    elif sys.platform.startswith('linux'):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode() + b'\0')
    else:
        raise RuntimeError('此系统不支持已验证的网卡绑定')
    sock.settimeout(8)
    sock.connect((str(ip), int(port)))
    return sock

def main():
    if len(sys.argv) == 5 and sys.argv[1] == '--stream':
        iface, host, port = sys.argv[2:]
        sock = bound_socket(iface, host, int(port))
        sock.settimeout(None)
        sel = selectors.DefaultSelector()
        sel.register(sock, selectors.EVENT_READ, 'remote')
        sel.register(sys.stdin.buffer, selectors.EVENT_READ, 'local')
        while True:
            for key, _ in sel.select(30):
                if key.data == 'remote':
                    data = sock.recv(65536)
                    if not data: return
                    sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
                else:
                    data = sys.stdin.buffer.read1(65536)
                    if not data:
                        sock.shutdown(socket.SHUT_WR); sel.unregister(sys.stdin.buffer)
                    else: sock.sendall(data)
    else:
        p = json.load(sys.stdin)
        started = time.monotonic()
        sock = bound_socket(p['interface'], p['host'], p['port'])
        if p.get('banner'):
            data = b''
            while b'SSH-2.0-' not in data and len(data) < 8192:
                block = sock.recv(1024)
                if not block: raise RuntimeError('入口响应但 SSH 后端未响应')
                data += block
            if b'SSH-2.0-' not in data: raise RuntimeError('后端没有 SSH 协议响应')
        print(json.dumps({'state':'ok','rtt':(time.monotonic()-started)*1000,'samples':1,'localAddress':sock.getsockname()[0],'interface':p['interface'],'transport':'direct'}))
        sock.close()
try:
    main()
except Exception as e:
    if '--stream' in sys.argv:
        print('DIRECT socket: '+str(e), file=sys.stderr); sys.exit(1)
    print(json.dumps({'state':'refused' if isinstance(e,ConnectionRefusedError) else 'no-response','rtt':None,'samples':0,'error':str(e)}))
