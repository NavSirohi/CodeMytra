import os
import subprocess
import time
import urllib.request

chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
port = 3000
url = f"http://localhost:{port}/projects/demo-project"

print("Starting Next.js development server with dev auth...")
env = os.environ.copy()
env["ALLOW_INSECURE_DEV_AUTH"] = "true"
env["NODE_ENV"] = "development"

server_process = subprocess.Popen(
    ["npm", "run", "dev"],
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True
)

try:
    # Wait for server to become ready
    ready = False
    for i in range(30):
        time.sleep(1)
        try:
            req = urllib.request.Request(f"http://localhost:{port}/")
            with urllib.request.urlopen(req, timeout=2) as resp:
                if resp.status == 200:
                    ready = True
                    break
        except Exception:
            pass

    if not ready:
        raise RuntimeError("Server failed to start within 30 seconds")

    print("Warming up /projects/demo-project compilation...")
    try:
        urllib.request.urlopen(f"http://localhost:{port}/projects/demo-project", timeout=10)
    except Exception as e:
        print("Warmup finished with:", e)

    time.sleep(2)

    print("Next.js server is ready. Capturing screenshots...")
    os.makedirs("screenshots", exist_ok=True)

    viewports = [
        ("studio_desktop.png", "--window-size=1280,900"),
        ("studio_mobile.png", "--window-size=390,844"),
    ]

    for filename, vp_flag in viewports:
        out_path = os.path.join("screenshots", filename)
        cmd = [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--virtual-time-budget=3000",
            vp_flag,
            f"--screenshot={out_path}",
            url
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if os.path.exists(out_path):
            size_kb = os.path.getsize(out_path) // 1024
            print(f"✓ Captured {filename} ({size_kb} KB)")
        else:
            print(f"✗ Failed to capture {filename}: {res.stderr.decode('utf-8')}")

finally:
    print("Terminating Next.js server...")
    server_process.terminate()
    try:
        server_process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server_process.kill()
    print("Server terminated.")
