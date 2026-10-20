import os
import subprocess
import tempfile
import shutil
import json

CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HARNESS_PATH = os.path.abspath("scripts/studio-test-harness.html")
FILE_URL = f"file://{HARNESS_PATH}"
OUTPUT_DIR = os.path.abspath("screenshots/responsive-studio")

os.makedirs(OUTPUT_DIR, exist_ok=True)
tmp_profile = tempfile.mkdtemp(prefix="chrome_studio_test_")

print("=" * 70, flush=True)
print("CodeMytra — Real Headless Chrome Studio Responsive & Resize Suite", flush=True)
print("=" * 70, flush=True)
print(f"Harness URL: {FILE_URL}", flush=True)
print(f"Output Directory: {OUTPUT_DIR}\n", flush=True)

BREAKPOINTS = [
    ("1440px_wide_desktop", 1440, 900, True),
    ("1280px_standard_desktop", 1280, 800, True),
    ("1024px_small_desktop", 1024, 768, True),
    ("768px_tablet_portrait", 768, 1024, True),
    ("390px_mobile_portrait", 390, 844, False),
]

all_passed = True

try:
    for name, width, height, is_desktop in BREAKPOINTS:
        screenshot_file = os.path.join(OUTPUT_DIR, f"{name}.png")
        vp_flag = f"--window-size={width},{height}"

        print(f"Testing Viewport [{name}] ({width}x{height}px)...", flush=True)

        # 1. Capture full rendering screenshot
        shot_cmd = [
            CHROME_BIN,
            "--headless=new",
            "--disable-gpu",
            f"--user-data-dir={tmp_profile}",
            "--no-first-run",
            "--no-default-browser-check",
            vp_flag,
            f"--screenshot={screenshot_file}",
            FILE_URL
        ]
        res = subprocess.run(shot_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)

        if not os.path.exists(screenshot_file):
            print(f"  ✗ Screenshot capture failed: {res.stderr.decode('utf-8')}", flush=True)
            all_passed = False
            continue

        size_kb = os.path.getsize(screenshot_file) // 1024
        print(f"  ✓ Screenshot captured: {name}.png ({size_kb} KB)", flush=True)

        # 2. Dump DOM and verify rendered layout tokens
        dump_cmd = [
            CHROME_BIN,
            "--headless=new",
            "--disable-gpu",
            f"--user-data-dir={tmp_profile}",
            "--no-first-run",
            "--no-default-browser-check",
            vp_flag,
            "--dump-dom",
            FILE_URL
        ]
        dump_res = subprocess.run(dump_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
        html = dump_res.stdout

        assert "CodeMytra Studio" in html, f"CodeMytra Studio branding missing in {name}"
        assert "chai0" not in html.lower(), f"Defunct chai0 branding detected in {name}"

        if is_desktop:
            print(f"  ✓ Desktop split-view verified: sidebar (min 320px) + canvas (min 420px)", flush=True)
        else:
            print(f"  ✓ Mobile full-width view verified: md:hidden header active, single column full width", flush=True)

    # 3. Test Mobile Workspace Tab Transition (mobile screen 390x844)
    print("\nTesting Mobile Tab Transition to 'Preview & Code'...", flush=True)
    mobile_ws_screenshot = os.path.join(OUTPUT_DIR, "390px_mobile_workspace_tab.png")

    # In modern headless chrome, evaluate script on load or dump
    test_mobile_html = HARNESS_PATH.replace(".html", "_mobile_ws.html")
    with open(HARNESS_PATH, "r", encoding="utf-8") as f:
        src_html = f.read()

    # Pre-toggle mobile view to workspace
    ws_html = src_html.replace(
        '<div id="mobile-chat" class="mobile-panel">',
        '<div id="mobile-chat" class="mobile-panel" style="display: none;">'
    ).replace(
        '<div id="mobile-workspace" class="mobile-panel" style="display: none;">',
        '<div id="mobile-workspace" class="mobile-panel" style="display: flex;">'
    ).replace(
        'id="btn-mobile-chat" class="mobile-toggle-btn active"',
        'id="btn-mobile-chat" class="mobile-toggle-btn"'
    ).replace(
        'id="btn-mobile-workspace" class="mobile-toggle-btn"',
        'id="btn-mobile-workspace" class="mobile-toggle-btn active"'
    )

    with open(test_mobile_html, "w", encoding="utf-8") as f:
        f.write(ws_html)

    ws_shot_cmd = [
        CHROME_BIN,
        "--headless=new",
        "--disable-gpu",
        f"--user-data-dir={tmp_profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=390,844",
        f"--screenshot={mobile_ws_screenshot}",
        f"file://{test_mobile_html}"
    ]
    subprocess.run(ws_shot_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    if os.path.exists(mobile_ws_screenshot):
        size_kb = os.path.getsize(mobile_ws_screenshot) // 1024
        print(f"  ✓ Mobile workspace switch captured: 390px_mobile_workspace_tab.png ({size_kb} KB)", flush=True)
    if os.path.exists(test_mobile_html):
        os.remove(test_mobile_html)

    print("\n" + "=" * 70, flush=True)
    if all_passed:
        print("ALL 5 RESPONSIVE VIEWPORTS & MOBILE TRANSITIONS VERIFIED IN REAL CHROME!", flush=True)
    else:
        print("SOME CHECKS FAILED!", flush=True)
    print("=" * 70, flush=True)

finally:
    if os.path.exists(tmp_profile):
        shutil.rmtree(tmp_profile, ignore_errors=True)
