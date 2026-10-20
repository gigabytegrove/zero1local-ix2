# -*- coding: utf-8 -*-
"""Truthful, read-only main data RAID consistency state for ix2-ng."""
from __future__ import print_function
import os

def read(path,fallback=''):
    try:
        with open(path,'r') as f: return f.read().strip()
    except Exception: return fallback

def status(server):
    import rc17_compat
    arrays=rc17_compat.raid_arrays(server)
    data=next((x for x in arrays if x.get('name')=='md1'),None)
    root='/sys/block/md1/md'
    result={'array':'/dev/md1','available':False,'running':False,'action':'idle',
            'mismatch_count':'0','percent_complete':0,
            'detail':'Main Storage RAID consistency is not available on this ix2.'}
    if not data:
        result['detail']='Main Storage RAID device /dev/md1 was not detected.'
        return result
    if data.get('level')!='raid1':
        result['detail']='Main Storage is not a RAID1 array.'
        return result
    if len(data.get('members',[]))<2 or data.get('raid_devices',0)<2:
        result['detail']='Main Storage has only one member and cannot provide disk mirroring.'
        return result
    if not os.path.isfile(root+'/sync_action'):
        result['detail']='This kernel does not expose RAID consistency controls.'
        return result
    action=read(root+'/sync_action','idle')
    pct=0.0
    done=read(root+'/sync_completed')
    if '/' in done:
        try:
            parts=done.split('/');pct=100*float(parts[0].strip())/float(parts[1].strip())
        except Exception: pass
    result.update({'available':True,'running':action in ('check','repair','resync','recover'),
                   'action':action,'percent_complete':max(0,min(100,pct)),
                   'mismatch_count':read(root+'/mismatch_cnt','0'),
                   'detail':'RAID consistency status from /sys/block/md1/md.'})
    return result

def may_check(server):
    st=status(server)
    return st['available'] and not st['running'] and os.access('/sys/block/md1/md/sync_action',os.W_OK)
