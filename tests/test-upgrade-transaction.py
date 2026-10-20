#!/usr/bin/env python3
"""Exercise the real shell installer in isolated temporary trees; never touch a NAS."""
import hashlib,json,os,pathlib,subprocess,sys,tempfile,zipfile
PACKAGE=pathlib.Path(sys.argv[1])
VERSION='0.9.1-rc2'

def case(fail):
    with tempfile.TemporaryDirectory(prefix='ix2-updater-simulation-') as td:
        work=pathlib.Path(td);base=work/'nas'
        (base/'releases'/'legacy').mkdir(parents=True);(base/'state').mkdir()
        (work/'etc').mkdir();(work/'bin').mkdir();(work/'source').mkdir()
        prev=base/'releases'/'legacy'
        (prev/'server.py').write_text('previous working instance')
        (prev/'VERSION').write_text('0.8.14-runtime-ownership-hardening\n')
        (base/'current').symlink_to('releases/legacy')
        init=work/'etc'/'zero1local-ix2'
        init_src='#!/bin/sh\nif [ "$1" = status ]; then echo ui=running;echo recovery_proxy=running;echo runtime_service_supervisor=running;echo stock_443=closed;echo recovery_18443=open;fi\n'
        init.write_text(init_src);init.chmod(0o755)
        with zipfile.ZipFile(PACKAGE) as z:z.extractall(work/'source')
        src=work/'source';installer=src/'install-update.sh'
        (src/'zero1local-ix2.init').write_text(init_src)
        shell=installer.read_text()
        shell=shell.replace('ROOT=/mnt/system/zero1local-ix2','ROOT='+str(base))
        shell=shell.replace('INIT=/etc/init.d/zero1local-ix2','INIT='+str(init))
        shell=shell.replace('case "$(uname -m)"','case "armv5tel"')
        shell=shell.replace('case "$(uname -r)"','case "2.6.31.8"')
        shell=shell.replace('[ -d /mnt/system ] && [ -d /mnt/pools ]','[ -d "'+str(base)+'" ] && [ -d "'+str(base)+'" ]')
        shell=shell.replace('df -kP /mnt/system','df -kP "'+str(base)+'"')
        shell=shell.replace("DATADEV=$(df -kP /mnt/pools/A/A0 2>/dev/null | awk 'NR==2{print $1}' || :)",'DATADEV=simulated-other-device')
        shell=shell.replace('"$i" -lt 20','"$i" -lt 2').replace('sleep 2','sleep 0')
        installer.write_text(shell)
        doc=src/'manifest.json';m=json.loads(doc.read_text())
        for name in ('install-update.sh','zero1local-ix2.init'):
            m['files'][name]=hashlib.sha256((src/name).read_bytes()).hexdigest()
        doc.write_text(json.dumps(m,sort_keys=True))
        wget=work/'bin'/'wget'
        wget.write_text('#!/bin/sh\n'+('exit 1\n' if fail else 'echo \'{\"ix2_backend\":\"'+VERSION+'\",\"ok\":true}\'\n'))
        wget.chmod(0o755)
        env=dict(os.environ);env['PATH']=str(work/'bin')+':'+env['PATH']
        run=subprocess.run(['/bin/sh',str(installer),'--manual'],capture_output=True,text=True,timeout=40,env=env)
        if fail:
            assert run.returncode!=0,run.stdout+'\n'+run.stderr
            assert (base/'current').is_symlink()
            assert (base/'current'/'server.py').read_text()=='previous working instance'
            assert init.read_text()==init_src
            print('PASS rollback: original symlink and init restored')
        else:
            assert run.returncode==0,run.stdout+'\n'+run.stderr
            assert (base/'current'/'VERSION').read_text().strip()==VERSION
            assert json.loads((base/'state'/'update-apply.json').read_text())['status']=='succeeded'
            assert (base/'releases'/'legacy'/'server.py').read_text()=='previous working instance'
            saved=list((base/'releases').rglob('current-snapshot/server.py'))
            assert saved and saved[0].read_text()=='previous working instance'
            print('PASS activation: new version healthy, previous runtime snapshotted')

case(False)
case(True)
