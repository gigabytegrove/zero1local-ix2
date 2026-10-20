#!/usr/bin/env python3
"""Build a checksum-verified ARMv5 ix2 UI compatibility candidate, without NAS writes."""
import argparse
import hashlib
import json
from pathlib import Path
import stat
import tempfile
import zipfile

BASE_SHA = 'd59748e47cc3f8ea6baea677cb03848748c40a457671fd21293e79b2825653b6'
BASE = '0.9.0-rc1'
VERSION = '0.9.1-rc2'
ROOTS = ('current/', 'manifest.json', 'zero1local-ix2.init', 'install-update.sh')

def sha(b):
    return hashlib.sha256(b).hexdigest()

def one_replace(data, before, after, why):
    if data.count(before) != 1:
        raise ValueError('expected one occurrence of %s (found %s)' % (why, data.count(before)))
    return data.replace(before, after)

def install_patch(s):
    s = one_replace(s, "VERSION='0.9.0-rc1'", "VERSION='0.9.1-rc2'", 'installer version')
    s = one_replace(s,
        '[ ! -L "$ROOT" ] && [ ! -L "$ROOT/current" ] || fail \'unexpected symlink in installation tree\'',
        '[ ! -L "$ROOT" ] || fail \'installation root cannot be a symlink\'\n'
        '# Preserve a canonical root-owned internal version pointer, never follow it outside $ROOT.\n'
        'if [ -L "$ROOT/current" ]; then\n'
        '  "$PY" - "$ROOT" <<\'PYLINK\'\n'
        'import os,sys,stat\n'
        'base=os.path.realpath(sys.argv[1]); current=os.path.join(base,"current")\n'
        'target=os.path.realpath(current)\n'
        'assert target.startswith(base+os.sep), "current points outside managed root"\n'
        'st=os.stat(target)\n'
        'assert st.st_uid==0 and not(st.st_mode & 0o022), "unsafe target permissions"\n'
        'assert os.path.isfile(os.path.join(target,"server.py")), "target lacks runtime"\n'
        'PYLINK\n'
        'fi', 'internal symlink protection')
    s = one_replace(s,
        'mv "$ROOT/current" "$PREVIOUS/current"',
        'if [ -L "$ROOT/current" ]; then\n'
        '  mkdir "$PREVIOUS/current-snapshot" || fail \'cannot create original snapshot\'\n'
        '  cp -pR "$ROOT/current/." "$PREVIOUS/current-snapshot/" || fail \'cannot snapshot old app\'\n'
        '  [ -f "$PREVIOUS/current-snapshot/server.py" ] || fail \'invalid snapshot\'\n'
        'fi\n'
        'mv "$ROOT/current" "$PREVIOUS/current"', 'original pointer snapshot')
    s = one_replace(s,
        'if [ -d "$PREVIOUS/current" ]; then mv "$PREVIOUS/current" "$ROOT/current" || :; fi',
        'if [ -d "$PREVIOUS/current" ] || [ -L "$PREVIOUS/current" ]; then mv "$PREVIOUS/current" "$ROOT/current" || :; fi', 'rollback symlink')
    s = one_replace(s,
        '[ -d "$PREVIOUS/current" ] && [ ! -e "$ROOT/current" ]',
        '{ [ -d "$PREVIOUS/current" ] || [ -L "$PREVIOUS/current" ]; } && [ ! -e "$ROOT/current" ] && [ ! -L "$ROOT/current" ]', 'early rollback symlink')
    old = '''*'"ok":true'*'"ix2_backend":"0.9.0-rc1"'*'''
    new = '''*'"ok":true'*'"ix2_backend":"0.9.1-rc2"'*|*'"ix2_backend":"0.9.1-rc2"'*'"ok":true'*'''
    if s.count(old) != 2:
        raise ValueError('unexpected health patterns (%d)' % s.count(old))
    s = s.replace(old, new)
    return s

def safe_extract(src, root):
    with zipfile.ZipFile(src) as z:
        infos=z.infolist()
        if len(infos) > 100 or not infos:
            raise ValueError('unexpected archive entry count')
        seen=set(); total=0
        for entry in infos:
            n=entry.filename
            if n in seen or n.startswith('/') or '\\' in n or '\x00' in n or any(p in ('', '.', '..') for p in n.split('/')):
                raise ValueError('unsafe ZIP entry '+repr(n))
            if not (n.startswith('current/') or n in ROOTS):
                raise ValueError('unexpected archive member '+n)
            if ((entry.external_attr>>16) & stat.S_IFMT(0o170000)) not in (0, stat.S_IFREG):
                raise ValueError('nonregular file '+n)
            seen.add(n); total+=entry.file_size
            if total>16*1024*1024:
                raise ValueError('archive is too large')
        z.extractall(root)
    manifest=json.loads((root/'manifest.json').read_text())
    if manifest.get('version')!=BASE or manifest.get('hardware_profile')!='lenovo-iomega-ix2-ng-armel':
        raise ValueError('wrong hardware/version')
    for name,digest in manifest['files'].items():
        if name not in seen or sha((root/name).read_bytes())!=digest:
            raise ValueError('manifest mismatches '+name)

def build(base, frontend, output):
    if sha(base.read_bytes()) != BASE_SHA:
        raise ValueError('base ZIP SHA-256 does not match pinned published rc1 asset')
    if not (frontend/'app.js').is_file() or not (frontend/'app.css').is_file() or not (frontend/'index.html').is_file():
        raise ValueError('frontend assets missing')
    js=(frontend/'app.js').read_text()
    for marker in ("const UI_BUILD_VERSION = '1.4.0'",'class="app-frame"','class="auth-card"','class="application-rail"','const IX2_HARDWARE_PORT = true'):
        if marker not in js:
            raise ValueError('frontend parity marker missing '+marker)
    with tempfile.TemporaryDirectory(prefix='ix2-parity-build-') as td:
        root=Path(td)
        safe_extract(base, root)
        for f in frontend.rglob('*'):
            if f.is_symlink():
                raise ValueError('frontend symlinks are forbidden')
            if f.is_file():
                dest=root/'current'/'web'/f.relative_to(frontend)
                dest.parent.mkdir(parents=True,exist_ok=True)
                dest.write_bytes(f.read_bytes())
        v=root/'current'/'VERSION'; v.write_text(VERSION+'\n')
        p=root/'current'/'server.py'; s=p.read_text()
        s=one_replace(s,"IX2_RELEASE = '0.9.0-rc1'", "IX2_RELEASE = '0.9.1-rc2'",'server release ID')
        s=one_replace(s,
            "        if path=='/api/files/upload' and method=='POST':",
            "        if path=='/api/update/upload' and method=='POST':\n"
            "            import ix2_update_local\n"
            "            return ix2_update_local.upload(self, sys.modules[__name__])\n"
            "        if path=='/api/files/upload' and method=='POST':",
            'authenticated release ZIP upload route')
        s=one_replace(s, "server_version = 'Zero1Local-ix2/0.9.0-rc1'",
                      "server_version = 'Zero1Local-ix2/0.9.1-rc2'", 'HTTP server version')
        p.write_text(s)
        p=root/'current'/'rc17_compat.py'; s=p.read_text()
        s=one_replace(s,"PRODUCT_VERSION = '0.9.0-rc1 (Zero1Local v1.4 backport)'", "PRODUCT_VERSION = '0.9.1-rc2 (Zero1Local v1.4 UI compatibility preview)'",'version label')
        p.write_text(s)
        p=root/'current'/'ix2_update_local.py'
        p.write_bytes((Path(__file__).resolve().parents[1]/'src'/'ix2_update_local.py').read_bytes())
        p=root/'install-update.sh'; p.write_text(install_patch(p.read_text()))
        records=[]
        for f in sorted((root/'current').rglob('*')):
            if f.is_file() and f.name!='SHA256SUMS':
                records.append('%s  %s\n'%(sha(f.read_bytes()),f.relative_to(root/'current').as_posix()))
        (root/'current'/'SHA256SUMS').write_text(''.join(records))
        manifest=json.loads((root/'manifest.json').read_text())
        manifest.update(version=VERSION,reference_product_version='1.4.0',release_status='offline-ui-parity-preview-not-hardware-qualified',
            changes=['upstream v1.4.0 CSS and login/shell, ARMv5 app gating, authentic brand assets',
                     'ix2 admin account support', 'versioned ZIP integrity and symlink-aware rollback'],
            not_implemented=['full v1.4 backend API parity','SSH daemon modernization and removal of OEM password prefix',
                'new kernel, armel userspace','hardware reboot/update acceptance'])
        manifest['files']={f.relative_to(root).as_posix():sha(f.read_bytes()) for f in sorted(root.rglob('*')) if f.is_file() and f.name!='manifest.json'}
        (root/'manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
        output.parent.mkdir(parents=True,exist_ok=True)
        with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=8) as z:
            for f in sorted(root.rglob('*')):
                if not f.is_file(): continue
                relative=f.relative_to(root).as_posix()
                info=zipfile.ZipInfo(relative,(1980,1,1,0,0,0))
                info.create_system=3
                mode=0o755 if f.suffix=='.sh' or f.name in ('server.py','recovery_proxy.py','zero1local-ix2.init') else 0o644
                info.external_attr=(stat.S_IFREG|mode)<<16
                info.compress_type=zipfile.ZIP_DEFLATED
                z.writestr(info,f.read_bytes())
    print('BUILT',output)
    print('SHA256',sha(output.read_bytes()))
    print('VERSION',VERSION)

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--base-zip',type=Path,required=True)
    p.add_argument('--frontend-dir',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    a=p.parse_args()
    build(a.base_zip,a.frontend_dir,a.out)
