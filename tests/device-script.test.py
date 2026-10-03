import pathlib, unittest
from unittest.mock import patch
code=pathlib.Path('scripts/device/probe.py').read_text()
namespace={'__name__':'test_module'}
exec(compile(code,'probe.py','exec'),namespace)
class InterfaceSelection(unittest.TestCase):
    def test_active_thunderbolt_and_link_local_are_not_ipv4_exits(self):
        replies={
            ('/usr/sbin/networksetup','-listallhardwareports'):(0,'Device: en0\nDevice: en1\nDevice: en2\nDevice: en3\n'),
            ('/sbin/ifconfig','en0'):(0,'inet 192.168.2.4 netmask 0xffffff00\nstatus: active'),
            ('/sbin/ifconfig','en1'):(0,'inet6 fe80::1234\nstatus: active'),
            ('/sbin/ifconfig','en2'):(0,'inet 169.254.1.5\nstatus: active'),
            ('/sbin/ifconfig','en3'):(0,'inet 10.0.0.5\nstatus: inactive'),
        }
        with patch.object(namespace['sys'],'platform','darwin'),patch.dict(namespace,{'command':lambda a:replies[tuple(a)]}):
            self.assertEqual(namespace['physical_interfaces'](),['en0'])

    def choose(self, default='utun6', routed=('en0',), requested=None, tty=False, answers=()):
        def command(args):
            self.assertEqual(args[:3],['/sbin/route','-n','get'])
            if args[3:] == ['default']:return 0,'interface: '+default+'\n'
            iface=args[4]
            return (0,'interface: '+iface+'\ngateway: 192.168.2.1\nflags: <UP,GATEWAY>') if iface in routed else (1,'not in table')
        with patch.object(namespace['sys'],'platform','darwin'),patch.object(namespace['sys'].stdin,'isatty',return_value=tty),patch.dict(namespace,{'physical_interfaces':lambda:['en0','en1'],'command':command}),patch('builtins.input',side_effect=answers):
            return namespace['select_interface'](requested)

    def test_vpn_default_uses_only_routed_physical_adapter(self):
        self.assertEqual(self.choose(), 'en0')

    def test_two_physical_exits_prefer_system_physical_default(self):
        self.assertEqual(self.choose(default='en1',routed=('en0','en1')), 'en1')

    def test_explicit_choice_is_not_overridden(self):
        self.assertEqual(self.choose(default='en0',routed=('en0','en1'),requested='en1'),'en1')
        with self.assertRaisesRegex(RuntimeError,'指定的物理网卡不可用'):self.choose(requested='utun6')

    def test_ambiguous_exits_offer_terminal_choice(self):
        self.assertEqual(self.choose(routed=('en0','en1'),tty=True,answers=['utun6','2']), 'en1')

    def test_ambiguous_noninteractive_stops_without_guessing(self):
        with self.assertRaisesRegex(RuntimeError,'多个物理出口'):self.choose(routed=('en0','en1'))

    def test_no_physical_route_or_cancel_stops(self):
        with self.assertRaisesRegex(RuntimeError,'没有可确认'):self.choose(routed=())
        with self.assertRaisesRegex(RuntimeError,'用户取消'):self.choose(routed=('en0','en1'),tty=True,answers=['q'])

class DirectScript(unittest.TestCase):
    def test_bound_ping_flags(self):
        sys=namespace['sys'];old=sys.platform
        try:
            sys.platform='darwin';a=namespace['ping_args']('en0','8.8.8.8',3)
            self.assertIn('-b',a);self.assertEqual(a[a.index('-b')+1],'en0');self.assertIn('-m',a)
            sys.platform='linux';a=namespace['ping_args']('eth0','8.8.8.8',3)
            self.assertIn('-I',a);self.assertEqual(a[a.index('-I')+1],'eth0');self.assertIn('-t',a)
        finally:sys.platform=old
    def test_route_mismatch_blocks(self):
        physical=namespace['physical_interfaces'];command=namespace['command'];sys=namespace['sys'];old=sys.platform
        try:
            namespace['physical_interfaces']=lambda:['en0'];namespace['command']=lambda *a:(0,'interface: utun9\n');sys.platform='darwin'
            with self.assertRaises(RuntimeError):namespace['check_route']('en0','8.8.8.8')
        finally:namespace['physical_interfaces']=physical;namespace['command']=command;sys.platform=old
    def test_raw_ping_checksum_and_interface(self):
        import struct
        sockmod=namespace['socket'];original=sockmod.socket;binding=getattr(sockmod,'SO_BINDTODEVICE',None);sockmod.SO_BINDTODEVICE=25
        class FakeSocket:
            sent=None
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def setsockopt(self,*a):pass
            def getsockopt(self,*a):return b'eth0\0'
            def settimeout(self,*a):pass
            def sendto(self,p,address):
                self.sent=p
                words=struct.unpack('!'+str(len(p)//2)+'H',p)
                total=sum(words)
                while total>>16:total=(total&65535)+(total>>16)
                assert total==65535
            def recvfrom(self,*a):return bytes([69])+bytes(19)+bytes([0])+self.sent[1:],('8.8.8.8',0)
        try:
            sockmod.socket=lambda *a:FakeSocket()
            hop,ms,reached=namespace['linux_raw_ping']('eth0','8.8.8.8')
            self.assertEqual(hop,'8.8.8.8');self.assertTrue(reached);self.assertGreaterEqual(ms,0)
        finally:
            sockmod.socket=original
            if binding is None:del sockmod.SO_BINDTODEVICE
            else:sockmod.SO_BINDTODEVICE=binding
class ServiceProbe(unittest.TestCase):
    def test_bind_failure_sends_nothing(self):
        check=namespace['check_route'];bind=namespace['bind_physical'];sockmod=namespace['socket'];original=sockmod.socket
        class FakeSocket:
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def connect(self,*a):raise AssertionError('must not connect without binding')
        try:
            namespace['check_route']=lambda *a:None
            namespace['bind_physical']=lambda *a:(_ for _ in ()).throw(RuntimeError('binding failed'))
            sockmod.socket=lambda *a:FakeSocket()
            result=namespace['service_probe']({'id':'a','name':'A','ip':'8.8.8.8','port':22,'method':'tcp'},'en0')
            self.assertEqual(result['samples'],[]);self.assertIn('binding failed',result['error'])
        finally:namespace['check_route']=check;namespace['bind_physical']=bind;sockmod.socket=original
    def test_ssh_banner_validation(self):
        check=namespace['check_route'];bind=namespace['bind_physical'];sockmod=namespace['socket'];original=sockmod.socket
        class FakeSocket:
            payload=b'SSH-2.0-test\r\n'
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def settimeout(self,*a):pass
            def connect(self,*a):pass
            def recv(self,*a):p=self.payload;self.payload=b'';return p
        try:
            namespace['check_route']=lambda *a:None;namespace['bind_physical']=lambda *a:None;sockmod.socket=lambda *a:FakeSocket()
            target={'id':'a','name':'A','ip':'8.8.8.8','port':22,'method':'ssh-banner'}
            self.assertEqual(len(namespace['service_probe'](target,'en0')['samples']),1)
            FakeSocket.payload=b'HTTP/1.1 200 OK\r\n'
            result=namespace['service_probe'](target,'en0');self.assertEqual(result['samples'],[]);self.assertIn('No SSH banner',result['error'])
        finally:namespace['check_route']=check;namespace['bind_physical']=bind;sockmod.socket=original
class ProbeSummary(unittest.TestCase):
    def test_route_only_does_not_claim_ping_failed(self):
        t={'name':'A','ip':'8.8.8.8','latency':False}
        r={'samples':[],'trace':'1 192.168.1.1\n2 *\n3 8.8.8.8'}
        out=namespace['probe_summary'](t,r)
        self.assertIn('未执行 Ping 延迟测试',out);self.assertIn('3 跳，2 跳有响应，已到达目标',out)
        self.assertNotIn('No ICMP',out);self.assertNotIn('Ping 未收到回包',out)
    def test_real_ping_timeout_and_incomplete_route_are_distinct(self):
        out=namespace['probe_summary']({'name':'A','ip':'8.8.8.8','latency':True},{'samples':[],'trace':'1 *\n2 *'})
        self.assertIn('Ping 未收到回包（0/3）',out);self.assertIn('0 跳有响应，未确认到达目标',out)
    def test_route_only_sends_ttl_probe_without_latency_sampling(self):
        from unittest.mock import patch
        import contextlib,io
        class Sock:
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def setsockopt(self,*a):pass
            def getsockopt(self,*a):return 7
        commands=[]
        def command(args,*a):
            commands.append(args)
            return 0,'64 bytes from 8.8.8.8: icmp_seq=0 ttl=55 time=10.5 ms'
        t={'id':'a','name':'A','ip':'8.8.8.8','latency':False}
        with patch.object(namespace['sys'],'platform','darwin'),patch.object(namespace['socket'],'socket',return_value=Sock()),patch.object(namespace['socket'],'if_nametoindex',return_value=7),patch.dict(namespace,{'check_route':lambda *a:None,'command':command}),contextlib.redirect_stdout(io.StringIO()) as printed:
            r=namespace['probe'](t,'en0',True)
        self.assertEqual(r['samples'],[]);self.assertEqual(len(commands),1);self.assertIn('-m',commands[0]);self.assertEqual(r['trace'],'1 8.8.8.8');self.assertIn('已到达目标',printed.getvalue())
unittest.main()
