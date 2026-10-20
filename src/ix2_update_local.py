# -*- coding: utf-8 -*-
"""Authenticated, digest-pinned ZIP installation when the ix2 legacy TLS cannot download assets.

The archive MUST match the SHA-256 of the selected public GitHub release.
This module is Python 2.7 compatible and never modifies disks or RAID.
"""
from __future__ import print_function
import hashlib
import json
import os
import shutil
import subprocess
import time
import uuid
import zipfile

MAX_PACKAGE_BYTES = 16 * 1024 * 1024

def upload(handler, server):
    session=handler.current_session()
    if not session or session.get('role')!='administrator':
        return handler.send_json({'error':'administrator session required'},401)
    if not handler.action_header_ok():
        return handler.send_json({'error':'missing Zero1Local request header'},403)
    if not str(handler.headers.get('Content-Type','')).lower().startswith('application/zip'):
        return handler.send_json({'error':'application/zip is required'},415)
    try: length=int(handler.headers.get('Content-Length','0'))
    except Exception: length=0
    if length<=0 or length>MAX_PACKAGE_BYTES:
        return handler.send_json({'error':'invalid update size (maximum 16 MiB)'},413)
    state=server.load_native_state()
    rel=state.get('updates',{}).get('available')
    if not isinstance(rel,dict) or not rel.get('ready_for_update'):
        return handler.send_json({'error':'check for a verified GitHub update before uploading'},409)
    version=server.to_text(rel.get('version',''))
    expected=server.to_text(rel.get('asset_digest',''))
    if not version or not expected.startswith('sha256:'):
        return handler.send_json({'error':'release does not contain a verified SHA-256 asset digest'},409)
    try: existing=server._update_apply_load()
    except Exception: existing={}
    if isinstance(existing,dict) and existing.get('status')=='running':
        return handler.send_json({'error':'another update is running'},409)
    base=server.UPDATE_STAGE_ROOT
    if os.path.islink(base):
        return handler.send_json({'error':'unsafe update staging directory'},409)
    if not os.path.isdir(base): os.makedirs(base,0o700)
    try: os.chmod(base,0o700)
    except Exception: pass
    task_id='local-update-%s'%uuid.uuid4().hex
    stage=os.path.join(base,task_id)
    os.mkdir(stage,0o700)
    archive=os.path.join(stage,'update.zip')
    result={'task_id':task_id,'version':version,'status':'running','stage':'receiving','started_at':int(time.time()),'error':''}
    server._update_apply_save(result)
    try:
        remaining=length
        digest=hashlib.sha256()
        with open(archive,'wb') as out:
            while remaining:
                block=handler.rfile.read(min(65536,remaining))
                if not block: raise ValueError('upload interrupted')
                out.write(block);digest.update(block);remaining-=len(block)
            out.flush();os.fsync(out.fileno())
        result['stage']='verifying-sha256';server._update_apply_save(result)
        actual='sha256:'+digest.hexdigest()
        if not server.secure_compare(actual,expected):
            raise ValueError('uploaded ZIP differs from published GitHub asset SHA-256')
        with zipfile.ZipFile(archive,'r') as z:
            server._safe_zip(z)
            manifest=json.loads(server.to_text(z.read('manifest.json')))
            if manifest.get('product')!='Zero1Local-ix2' or manifest.get('hardware_profile')!='lenovo-iomega-ix2-ng-armel':
                raise ValueError('wrong product or hardware profile')
            if server.to_text(manifest.get('version',''))!=version:
                raise ValueError('ZIP version differs from selected GitHub release')
            server._verify_ix2_package(z,manifest)
            extracted=os.path.join(stage,'extracted')
            os.mkdir(extracted,0o700)
            z.extractall(extracted)
        installer=os.path.join(extracted,'install-update.sh')
        if not os.path.isfile(installer) or os.path.islink(installer):
            raise ValueError('verified installer missing')
        result['stage']='installing';server._update_apply_save(result)
        log=os.path.join(server.STATE_ROOT,'update-install.log')
        cmd='sleep 2; nohup sh %s --from-updater >> %s 2>&1 < /dev/null &'%(server.shell_quote(installer),server.shell_quote(log))
        child=subprocess.Popen(['sh','-c',cmd],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        child.communicate()
        if child.returncode!=0: raise ValueError('installer launch failed')
        return handler.send_json({'ok':True,'task_id':task_id,'version':version,'stage':'installing','method':'verified-local-upload'},202)
    except Exception as exc:
        result.update({'status':'failed','stage':'failed','error':str(exc),'completed_at':int(time.time())})
        server._update_apply_save(result)
        try: shutil.rmtree(stage)
        except Exception: pass
        return handler.send_json({'error':'update upload rejected: '+str(exc),'task_id':task_id},409)
