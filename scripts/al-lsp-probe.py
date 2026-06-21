#!/usr/bin/env python3
"""
Direct raw-LSP probe for the AL language server (bypasses Claude Code).

Spawns the al-lsp-wrapper, speaks JSON-RPC over stdio, and reports exactly
where things stand: does initialize respond? does didOpen of a file with a
SYNTAX ERROR produce a publishDiagnostics notification? does documentSymbol
return? Captures the wrapper's stderr so a missing AL_EXTENSION_PATH / host
shows up instead of an opaque hang.

Usage:
  python3 al-lsp-probe.py <wrapper-path> <root-dir> <al-file-abs>
Env:
  (wrapper reads AL_EXTENSION_PATH itself if exported)
"""
import json, os, subprocess, sys, threading, time, queue, pathlib

wrapper = sys.argv[1]
root = os.path.abspath(sys.argv[2])
al_file = os.path.abspath(sys.argv[3])
root_uri = pathlib.Path(root).as_uri()
file_uri = pathlib.Path(al_file).as_uri()

# A codeunit body with a deliberate SYNTAX error (parser-level → no symbols needed).
BROKEN_AL = (
    'codeunit 50000 "Probe Broken"\n'
    '{\n'
    '    procedure DoStuff()\n'
    '    begin\n'
    '        @@@ this is not valid AL $$$ ###\n'
    '    end;\n'
    '}\n'
)

proc = subprocess.Popen(
    [wrapper, "--launcher", "claude-code"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
)
assert proc.stdin and proc.stdout and proc.stderr  # PIPE => never None (and satisfies the type checker)
PIN, POUT, PERR = proc.stdin, proc.stdout, proc.stderr

inbox = queue.Queue()
stderr_lines = []

def read_stdout():
    f = POUT
    while True:
        # read headers
        header = b""
        while b"\r\n\r\n" not in header:
            ch = f.read(1)
            if not ch:
                inbox.put(None); return
            header += ch
        length = 0
        for line in header.decode("latin1").split("\r\n"):
            if line.lower().startswith("content-length:"):
                length = int(line.split(":")[1].strip())
        body = b""
        while len(body) < length:
            chunk = f.read(length - len(body))
            if not chunk:
                inbox.put(None); return
            body += chunk
        try:
            inbox.put(json.loads(body.decode("utf-8")))
        except Exception as e:
            inbox.put({"_parse_error": str(e), "_raw": body[:200].decode("latin1")})

def read_stderr():
    for line in PERR:
        stderr_lines.append(line.decode("latin1", "replace").rstrip())

threading.Thread(target=read_stdout, daemon=True).start()
threading.Thread(target=read_stderr, daemon=True).start()

def send(obj):
    data = json.dumps(obj)
    PIN.write(f"Content-Length: {len(data.encode())}\r\n\r\n{data}".encode())
    PIN.flush()

def wait_for(pred, timeout, label):
    t0 = time.time()
    seen = []
    while time.time() - t0 < timeout:
        try:
            msg = inbox.get(timeout=timeout - (time.time() - t0))
        except queue.Empty:
            break
        if msg is None:
            print(f"  [{label}] stdout closed (process exited?)")
            return None, seen
        seen.append(msg)
        if pred(msg):
            print(f"  [{label}] got it in {time.time()-t0:.1f}s")
            return msg, seen
    print(f"  [{label}] TIMEOUT after {timeout}s")
    return None, seen

print(f"wrapper: {wrapper}")
print(f"AL_EXTENSION_PATH={os.environ.get('AL_EXTENSION_PATH','(unset)')}")
print(f"root={root_uri}\nfile={file_uri}\n")

# 1. initialize
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "processId": os.getpid(), "rootUri": root_uri,
    "capabilities":{"textDocument":{"publishDiagnostics":{"relatedInformation":True}}},
    "workspaceFolders":[{"uri":root_uri,"name":"probe"}],
}})
init, _ = wait_for(lambda m: m.get("id")==1, 40, "initialize")

if init is None:
    print("\n✗ initialize did not respond — server failed to start.")
else:
    print("✓ initialize responded")
    send({"jsonrpc":"2.0","method":"initialized","params":{}})
    # 2. didOpen a file containing a syntax error
    send({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{
        "textDocument":{"uri":file_uri,"languageId":"al","version":1,"text":BROKEN_AL}}})
    # 3. wait for publishDiagnostics for our file
    diag, seen = wait_for(
        lambda m: m.get("method")=="textDocument/publishDiagnostics"
                  and m.get("params",{}).get("uri")==file_uri
                  and len(m.get("params",{}).get("diagnostics",[]))>0,
        45, "publishDiagnostics")
    if diag:
        ds = diag["params"]["diagnostics"]
        print(f"\n✓✓ DIAGNOSTICS PUBLISHED: {len(ds)} for our file")
        for d in ds[:8]:
            r = d.get("range",{}).get("start",{})
            print(f"    [{r.get('line')}:{r.get('character')}] {d.get('code','')} {d.get('message','')[:90]}")
    else:
        notifs = [m.get("method") for m in seen if m.get("method")]
        print(f"\n✗ no diagnostics for our file. notifications seen: {notifs[:10]}")

print("\n--- wrapper stderr (last 15 lines) ---")
for l in stderr_lines[-15:]:
    print("  " + l)

try:
    send({"jsonrpc":"2.0","id":99,"method":"shutdown","params":None})
    time.sleep(0.5)
except Exception:
    pass
proc.terminate()
