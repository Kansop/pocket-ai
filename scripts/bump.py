#!/usr/bin/env python3
"""Set one version everywhere so every deploy gets fresh, matching asset URLs.
Usage: python3 scripts/bump.py 1.5.0"""
import re, sys, pathlib
v = sys.argv[1]
root = pathlib.Path(__file__).resolve().parent.parent
def sub(path, pattern, repl):
    p = root / path; s = p.read_text(); n = re.sub(pattern, repl, s); p.write_text(n)
sub('index.html', r'(css/app\.css|js/app\.js)(\?v=[\w.]+)?"', lambda m: f'{m.group(1)}?v={v}"')
sub('index.html', r"window\.__POCKETAI_BUILD = '[\w.]*'", f"window.__POCKETAI_BUILD = '{v}'")
sub('js/app.js', r"from '\./(\w+)\.js(\?v=[\w.]+)?'", lambda m: f"from './{m.group(1)}.js?v={v}'")
sub('js/app.js', r"const APP_VERSION = '[\w.]+'", f"const APP_VERSION = '{v}'")
sub('js/app.js', r"worker\.js(\?v=[\w.]+)?'", f"worker.js?v={v}'")
sub('sw.js', r"const VERSION = 'pocketai-v[\w.]+'", f"const VERSION = 'pocketai-v{v}'")
sub('sw.js', r"const BUILD = '[\w.]+'", f"const BUILD = '{v}'")
print('version set to', v)
