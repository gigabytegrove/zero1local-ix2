#!/usr/bin/env python3
"""Isolated read-only HTTP smoke check against the packaged ix2 backend."""
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

PACKAGE=pathlib.Path(sys.argv[1]).resolve()
ROUTES=['/healthz','/api/status','/api/session','/api/system','/api/storage',
        '/api/storage/raid1/status','/api/shares','/api/users','/api/groups',
        '/api/files','/api/network','/api/hardware','/api/services',
        '/api/update/status','/api/tasks','/api/notifications',
        '/api/protection/status','/api/backups','/api/security',
        '/app.css?v=1.4.0','/app.js?v=1.4.0','/']

with tempfile.TemporaryDirectory(prefix='ix2-api-smoke-') as td:
    base=pathlib.Path(td)
    (base/'state').mkdir()
    with zipfile.ZipFile(PACKAGE) as archive:
        archive.extractall(base/'pkg')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        port=sock.getsockname()[1]
    env=dict(os.environ)
    env.update({'ZERO1LOCAL_IX2_STATE_ROOT':str(base/'state'),
                'ZERO1LOCAL_IX2_PORT':str(port),
                'ZERO1LOCAL_IX2_MODE':'staging',
                'ZERO1LOCAL_IX2_DEV_NOAUTH':'1'})
    cwd=base/'pkg'/'current'
    process=subprocess.Popen([sys.executable,'-u',str(cwd/'server.py')],
                             cwd=str(cwd),env=env,
                             stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    try:
        for path in ROUTES:
            uri='http://127.0.0.1:%s%s'%(port,path)
            for _ in range(40):
                try:
                    with urllib.request.urlopen(uri,timeout=3) as response:
                        status=response.status
                        body=response.read()
                    break
                except (OSError,urllib.error.URLError):
                    if process.poll() is not None:
                        raise AssertionError('server died during '+path)
                    time.sleep(.1)
            else:
                raise AssertionError('timeout from '+path)
            assert status==200,'HTTP %d from %s'%(status,path)
            if path=='/healthz' or path.startswith('/api/'):
                json.loads(body)
            if path=='/':
                assert b'/app.js?v=1.4.0' in body,'wrong HTML frontend'
            if path=='/app.js?v=1.4.0':
                assert len(body)>100_000,'incomplete v1.4 JS'
        print('PASS: %d isolated read-only HTTP routes, including v1.4 frontend and RAID status'%len(ROUTES))
    finally:
        process.terminate()
        try:process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
