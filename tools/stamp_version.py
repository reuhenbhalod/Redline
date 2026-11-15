"""Stamp a cache-busting version into web/index.html. Run before every push that changes web/:

    python3 tools/stamp_version.py

GitHub Pages lets browsers cache files for 10 minutes. Without versioned URLs a browser can mix a new
index.html with an old cached app.js (or old modules), and the app fails to start. This script:
  - adds ?v=<version> to every local stylesheet and to the app.js entry script, and
  - writes an import map that sends every local module import (./sim.js, ./map.js, ...) to ?v=<version>.
"""
import json, re, sys, time
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
version = sys.argv[1] if len(sys.argv) > 1 else time.strftime("%Y%m%d%H%M%S")
html_path = WEB / "index.html"
html = html_path.read_text()

# local stylesheets and the entry script
html = re.sub(r'href="([a-z]+\.css)(\?v=[^"]*)?"', rf'href="\1?v={version}"', html)
html = re.sub(r'src="app\.js(\?v=[^"]*)?"', f'src="app.js?v={version}"', html)

# import map for every local module (an import map must come before the first module script)
modules = sorted(p.name for p in WEB.glob("*.js"))
imap = {"imports": {f"./{m}": f"./{m}?v={version}" for m in modules}}
block = f'<script type="importmap" data-stamp>{json.dumps(imap, separators=(",", ":"))}</script>'
if "data-stamp" in html:
    html = re.sub(r'<script type="importmap" data-stamp>.*?</script>', block, html, flags=re.S)
else:
    html = html.replace('  <script type="module"', f'  {block}\n  <script type="module"', 1)

html_path.write_text(html)
print(f"stamped web/index.html with v={version} ({len(modules)} modules)")
