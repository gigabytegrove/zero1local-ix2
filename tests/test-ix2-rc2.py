#!/usr/bin/env python3
"""Offline validation of an ix2 v1.4.0 UI compatibility candidate."""
import hashlib,importlib.util,io,json,pathlib,subprocess,sys,tempfile,zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
PACKAGE=pathlib.Path(sys.argv[1])
FRONT=ROOT/'frontend'/'ix2'/'web'
BASE=ROOT/'frontend-reference'/'v1.4.0'/'web'
assert PACKAGE.is_file()
assert (FRONT/'app.css').read_bytes()==(BASE/'app.css').read_bytes(),'upstream CSS mismatch'
for n in ('zero1-local-logo.png','zero1-local-logo-light.png','zero1-local-logo-dark.png'):
    assert (FRONT/'assets'/n).read_bytes()==(BASE/'assets'/n).read_bytes(),'brand mismatch '+n
subprocess.run(['node','--check',str(FRONT/'app.js')],check=True)
with zipfile.ZipFile(PACKAGE) as z:
    names=z.namelist();assert len(names)==len(set(names)) and 'manifest.json' in names
    m=json.loads(z.read('manifest.json'))
    assert m['version']=='0.9.1-rc2'
    assert m['hardware_profile']=='lenovo-iomega-ix2-ng-armel'
    assert m['reference_product_version']=='1.4.0'
    assert set(names)==set(m['files'])|{'manifest.json'}
    for name,digest in m['files'].items():
        assert hashlib.sha256(z.read(name)).hexdigest()==digest,'invalid digest '+name
    assert z.read('current/web/app.css')==(BASE/'app.css').read_bytes()
    assert z.read('current/web/app.js')==(FRONT/'app.js').read_bytes()
    for n in ('current/server.py','current/rc17_compat.py','current/ix2_update_local.py','current/rc17_write_compat.py'):
        compile(z.read(n),n,'exec')
    import types
    runtime=types.ModuleType('ix2_version_test')
    runtime.__file__='server.py'
    exec(compile(z.read('current/server.py'),'server.py','exec'),runtime.__dict__)
    for newer,older in [('0.9.1-rc3','0.9.1-rc2'),('0.9.1','0.9.1-rc99'),
                        ('0.9.1-rc1','0.9.1-beta9'),('0.9.1-beta2','0.9.1-alpha10'),
                        ('0.9.1-rc2','0.9.0')]:
        assert runtime._version_tuple(newer)>runtime._version_tuple(older), 'incorrect RC ordering'
    assert b'/api/update/upload' in z.read('current/server.py')
    assert b"/api/storage/raid1/status" in z.read('current/server.py')
    assert b"/sys/block/md0/md/sync_action" not in z.read('current/server.py')
    assert 'current/ix2_raid_status.py' in names
    compile(z.read('current/ix2_raid_status.py'),'current/ix2_raid_status.py','exec')
    assert b"VERSION='0.9.1-rc2'" in z.read('install-update.sh')
    with tempfile.TemporaryDirectory() as td:
        p=pathlib.Path(td)/'install-update.sh';p.write_bytes(z.read('install-update.sh'))
        subprocess.run(['sh','-n',str(p)],check=True)
        p=pathlib.Path(td)/'ix2_update_local.py';p.write_bytes(z.read('current/ix2_update_local.py'))
        spec=importlib.util.spec_from_file_location('ix2_update_local',p)
        mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
        class Handler:
            def __init__(self,data):
                self.headers={'Content-Type':'application/zip','Content-Length':str(len(data))}
                self.rfile=io.BytesIO(data);self.status=None
            def current_session(self):return {'role':'administrator'}
            def action_header_ok(self):return True
            def send_json(self,body,status):self.status=status;return body
        class Server:
            UPDATE_STAGE_ROOT=str(pathlib.Path(td)/'stage')
            def load_native_state(self):
                return {'updates':{'available':{'ready_for_update':True,'version':'0.9.1-rc2','asset_digest':'sha256:'+'0'*64}}}
            def _update_apply_load(self):return {}
            def _update_apply_save(self,state):self.state=state
            to_text=str
            @staticmethod
            def secure_compare(a,b):return a==b
        h=Handler(b'NOT A RELEASE ZIP')
        response=mod.upload(h,Server())
        assert h.status==409 and 'SHA-256' in response['error'],'tampered upload accepted'
        class NotAdmin(Handler):
            def current_session(self):return None
        h=NotAdmin(b'UNTRUSTED')
        response=mod.upload(h,Server())
        assert h.status==401,'unauthenticated upload accepted'
print('PASS: upstream UI CSS/assets, JS syntax, package digests, installer syntax and upload rejection')
