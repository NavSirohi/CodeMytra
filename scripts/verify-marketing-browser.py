import json
import subprocess
import urllib.request
import os

routes = [
    ("/", "Build something meaningful | CodeMytra", "Describe a business website"),
    ("/product", "The Product | CodeMytra", "From a simple thought"),
    ("/how-it-works", "How it works | CodeMytra", "A team of specialists"),
    ("/pricing", "Pricing | CodeMytra", "CodeMytra early-access"),
    ("/about", "About and Team | CodeMytra", "Building tools that feel"),
    ("/contact", "Contact | CodeMytra", "Contact the CodeMytra"),
    ("/builder", "Builder Preview | CodeMytra", "Explore the CodeMytra"),
]

print("=== STEP 1: Verifying HTTP Response and Metadata ===")
for path, expected_title, expected_desc_snippet in routes:
    url = f"http://localhost:3000{path}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        body = resp.read().decode("utf-8")
        assert resp.status == 200, f"Expected 200 for {path}"
        assert f"<title>{expected_title}</title>" in body or expected_title in body, f"Title mismatch for {path}"
        assert 'name="description"' in body, f"Missing description meta tag in {path}"
        assert expected_desc_snippet.lower() in body.lower(), f"Description content mismatch for {path}"
        print(f"✓ {path:15} HTTP {resp.status} | Title: '{expected_title}'")

print("\n=== STEP 2: Capturing Multi-Device Screenshots (Desktop, Tablet, Mobile) ===")
chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
viewports = [
    ("desktop", "--window-size=1280,1000"),
    ("tablet", "--window-size=768,1024"),
    ("mobile", "--window-size=390,844"),
]

os.makedirs("screenshots/multi-device", exist_ok=True)
for path, _, _ in routes:
    slug = path.replace("/", "") or "index"
    for vp_name, vp_flag in viewports:
        out_file = f"screenshots/multi-device/{slug}_{vp_name}.png"
        cmd = [
            chrome, "--headless=new", "--disable-gpu", "--virtual-time-budget=2000",
            vp_flag, f"--screenshot={out_file}", f"http://localhost:3000{path}"
        ]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        size_kb = os.path.getsize(out_file) // 1024
        print(f"✓ Captured {slug:12} [{vp_name:7}] -> {out_file} ({size_kb} KB)")

print("\n=== STEP 3: Verifying Internal Link Targets ===")
# Check index page links
with urllib.request.urlopen("http://localhost:3000/") as resp:
    index_html = resp.read().decode("utf-8")
    for target in ["/product", "/how-it-works", "/pricing", "/about", "/contact", "/builder"]:
        assert f'href="{target}"' in index_html, f"Expected link to {target} in home page"
    print("✓ All 6 internal navigation links verified on home page")

print("\nAll browser navigation and multi-viewport checks PASSED!")
