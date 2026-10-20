#!/usr/bin/env python3
"""Fail a build when the shipped ix2 frontend is not yet at the v1.4.0 visual baseline.

Usage: python3 tools/check-v140-ui-parity.py path/to/installed/web
This test checks the frozen CSS baseline and common layout contract. It does not
claim backend/API parity or physical hardware qualification.
"""
import hashlib
import pathlib
import re
import sys

def fail(message):
    print("FAIL: " + message)
    return 1

def main():
    if len(sys.argv) != 2:
        print("usage: check-v140-ui-parity.py /path/to/ix2/web", file=sys.stderr)
        return 2
    repo_root = pathlib.Path(__file__).resolve().parents[1]
    ref = repo_root / "frontend-reference" / "v1.4.0" / "web"
    target = pathlib.Path(sys.argv[1])
    for filename in ("app.css", "app.js", "index.html"):
        if not (ref / filename).is_file():
            return fail("frozen upstream reference missing: " + filename)
        if not (target / filename).is_file():
            return fail("target asset missing: " + filename)
    reference_css = (ref / "app.css").read_bytes()
    target_css = (target / "app.css").read_bytes()
    css_checksum = hashlib.sha256(reference_css).hexdigest()
    if reference_css != target_css:
        return fail("the CSS is not the upstream v1.4.0 file (expected sha256 " + css_checksum + "); document any required ix2-specific overrides separately, do not silently fork styles")
    js = (target / "app.js").read_text(encoding="utf-8")
    upstream = (ref / "app.js").read_text(encoding="utf-8")
    structural = (
        "function brandLogoHTML(",
        'class="app-frame"',
        'class="application-rail"',
        'class="topbar-search"',
        "function authLogin(",
        'class="auth-card"',
        'data-zero1-brand-logo',
        "const applicationTabs =",
    )
    absent = [token for token in structural if token not in js]
    if absent:
        return fail("missing v1.4.0 UI structures: " + repr(absent))
    if js == upstream:
        print("PASS: exact frontend JS; functional API compatibility STILL UNVERIFIED")
    else:
        print("PASS: v1.4 structural UI markers; JS differs (ix2 adapter review REQUIRED)")
    print("PASS: CSS matches v1.4.0 sha256 " + css_checksum)
    print("NOTE: visual screenshot, backend, updater and appliance qualification remain separate gates")
    return 0

if __name__ == "__main__":
    sys.exit(main())
