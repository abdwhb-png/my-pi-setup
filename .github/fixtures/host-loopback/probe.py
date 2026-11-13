#!/usr/bin/env python3
"""CI-only feasibility experiment; this does not qualify a Zerobox implementation."""
import array
import ctypes
import errno
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading

ALIAS = "host.localhost"
ADDRESS = "198.18.0.1"


class CapabilityHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class CapabilityData(ctypes.Structure):
    _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]


def network_capability():
    libc = ctypes.CDLL(None, use_errno=True)
    header, data = CapabilityHeader(0x20080522, 0), (CapabilityData * 2)()
    if libc.prctl(47, 4, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "clear ambient capabilities")
    if libc.capget(ctypes.byref(header), ctypes.byref(data)) != 0:
        raise OSError(ctypes.get_errno(), "capget")
    data[0].inheritable |= 1 << 12
    if libc.capset(ctypes.byref(header), ctypes.byref(data)) != 0 or libc.prctl(47, 2, 12, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "ambient CAP_NET_ADMIN")


def receive_exact(stream, count):
    data = bytearray()
    while len(data) < count:
        part = stream.recv(count - len(data))
        if not part:
            raise RuntimeError("Unexpected end of control or probe stream")
        data.extend(part)
    return bytes(data)


def exchange(host, port, expected):
    with socket.create_connection((host, port), timeout=5) as stream:
        stream.sendall(b"probe")
        actual = receive_exact(stream, len(expected))
    if actual != expected:
        raise RuntimeError(f"Wrong route for {host}:{port}: {actual!r}")


def connect_host(port):
    try:
        return socket.create_connection(("127.0.0.1", port), timeout=5)
    except OSError as error:
        if error.errno != errno.ECONNREFUSED:
            raise
        return socket.create_connection(("::1", port), timeout=5)


def serve_echo(ip, reply, hits):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    server = socket.socket(family)
    server.bind((ip, 0))
    server.listen()
    server.settimeout(1)
    stopped = threading.Event()

    def run():
        while not stopped.is_set():
            try:
                client, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                if stopped.is_set():
                    return
                raise
            with client:
                client.settimeout(5)
                receive_exact(client, 5)
                hits.append(reply.decode())
                client.sendall(reply)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return server, stopped, thread


def child(control_path, host_port, denied_port, host_namespace):
    with socket.socket(socket.AF_UNIX) as control:
        control.connect(control_path)
        subprocess.run(["ip", "link", "set", "lo", "up"], preexec_fn=network_capability, check=True)
        subprocess.run(["ip", "address", "add", ADDRESS + "/32", "dev", "lo"], preexec_fn=network_capability, check=True)
        with tempfile.NamedTemporaryFile(mode="w") as hosts:
            hosts.write(f"127.0.0.1 localhost\n::1 localhost\n{ADDRESS} {ALIAS}\n")
            hosts.flush()
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.mount(hosts.name.encode(), b"/etc/hosts", None, 4096, None) != 0 or libc.mount(None, b"/etc/hosts", None, 4096 | 32 | 1, None) != 0:
                raise OSError(ctypes.get_errno(), "private hosts mount")
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        rules = f"""table ip pi_host_loopback {{
 chain output {{ type nat hook output priority dstnat; policy accept;
  ip daddr {ADDRESS} meta l4proto tcp redirect to :{port}
 }}
}}
"""
        subprocess.run(["nft", "-f", "-"], input=rules, text=True, preexec_fn=network_capability, check=True)
        control.sendmsg([b"R"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [listener.fileno()]))])
        listener.close()
        # The eventual target must not retain the privilege to alter routing.
        libc = ctypes.CDLL(None, use_errno=True)
        # Clear the bounding set before clearing CAP_SETPCAP, so exec cannot
        # restore privileges merely because the namespace UID is zero.
        for capability in range(64):
            if libc.prctl(24, capability, 0, 0, 0) != 0 and ctypes.get_errno() != errno.EINVAL:
                raise OSError(ctypes.get_errno(), "PR_CAPBSET_DROP")
        if libc.prctl(38, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "PR_SET_NO_NEW_PRIVS")
        header, data = CapabilityHeader(0x20080522, 0), (CapabilityData * 2)()
        if libc.capset(ctypes.byref(header), ctypes.byref(data)) != 0:
            raise OSError(ctypes.get_errno(), "capset")
        if subprocess.run(["nft", "list", "ruleset"], capture_output=True).returncode == 0:
            raise RuntimeError("Target retained network administration")
        if os.readlink("/proc/self/ns/net") == host_namespace:
            raise RuntimeError("Network namespace was not isolated")
        # Bind the same port privately: it must remain distinct from the host.
        with socket.socket() as private:
            private.bind(("127.0.0.1", host_port))
            private.listen()
            private.settimeout(5)
            def private_reply():
                client, _ = private.accept()
                with client:
                    receive_exact(client, 5)
                    client.sendall(b"PRIVATE")
            worker = threading.Thread(target=private_reply)
            worker.start()
            exchange("localhost", host_port, b"PRIVATE")
            worker.join(5)
            if worker.is_alive():
                raise RuntimeError("Private listener did not complete")
            exchange(ALIAS, host_port, b"HOST")
        control.sendall(b"L")
        late_port = struct.unpack("!H", receive_exact(control, 2))[0]
        exchange(ALIAS, late_port, b"LATE_HOST")
        with socket.create_connection((ALIAS, denied_port), timeout=5) as denied:
            denied.settimeout(5)
            try:
                denied.sendall(b"probe")
                result = denied.recv(128)
            except (ConnectionResetError, BrokenPipeError):
                result = b""
            if result:
                raise RuntimeError("Denied destination returned data")
        control.sendall(b"D")
        print(json.dumps({"transport": "namespace-nat-single-listener", "alias": ALIAS, "privateLocalhost": True, "lateHostService": True, "ipv6HostService": True, "brokerDenial": True, "targetCapabilitiesDropped": True, "namespaceUid": os.getuid()}))


def parent():
    hits, services, failures = [], [], []
    for reply in [b"HOST", b"DENIED"]:
        services.append(serve_echo("127.0.0.1", reply, hits))
    host_port, denied_port = [entry[0].getsockname()[1] for entry in services]
    with tempfile.TemporaryDirectory(prefix="pi-host-loopback-") as root:
        path = str(Path(root) / "control.sock")
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(path)
            server.listen()
            server.settimeout(30)
            mapping = ["--map-root-user"] if os.environ.get("HOST_LOOPBACK_MAP_USER") != "current" else [f"--map-user={os.getuid()}", f"--map-group={os.getgid()}"]
            proc = subprocess.Popen(["unshare", "--user", "--keep-caps", *mapping, "--mount", "--net", sys.executable, __file__, "--child", path, str(host_port), str(denied_port), os.readlink("/proc/self/ns/net")])
            try:
                with server.accept()[0] as control:
                    control.settimeout(30)
                    payload, ancillary, flags, _ = control.recvmsg(1, socket.CMSG_SPACE(array.array("i").itemsize))
                    if payload != b"R" or flags & socket.MSG_CTRUNC or len(ancillary) != 1:
                        try:
                            proc.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            pass
                        raise RuntimeError(f"Invalid listener transfer: payload={payload!r}, flags={flags}, controls={[(level, kind, len(raw)) for level, kind, raw in ancillary]}")
                    level, kind, raw = ancillary[0]
                    if (level, kind) != (socket.SOL_SOCKET, socket.SCM_RIGHTS):
                        raise RuntimeError("Missing listener descriptor")
                    descriptors = array.array("i")
                    descriptors.frombytes(raw)
                    if len(descriptors) != 1:
                        raise RuntimeError("Expected one listener")
                    listener = socket.socket(fileno=descriptors[0])
                    listener.settimeout(1)
                    done = threading.Event()
                    def relay():
                        while not done.is_set():
                            try:
                                client, _ = listener.accept()
                            except socket.timeout:
                                continue
                            except OSError:
                                if done.is_set():
                                    return
                                raise
                            try:
                                with client:
                                    client.settimeout(5)
                                    original = client.getsockopt(socket.SOL_IP, 80, 16)  # SO_ORIGINAL_DST
                                    port = struct.unpack("!H", original[2:4])[0]
                                    if socket.inet_ntoa(original[4:8]) != ADDRESS:
                                        raise RuntimeError("Unexpected original destination")
                                    if port == denied_port:
                                        continue
                                    with connect_host(port) as upstream:
                                        upstream.sendall(receive_exact(client, 5))
                                        while True:
                                            part = upstream.recv(128)
                                            if not part:
                                                break
                                            client.sendall(part)
                            except Exception as error:
                                failures.append(str(error))
                    worker = threading.Thread(target=relay, daemon=True)
                    worker.start()
                    try:
                        if control.recv(1) != b"L":
                            raise RuntimeError("Missing late-service request")
                        late = serve_echo("::1", b"LATE_HOST", hits)
                        services.append(late)
                        control.sendall(struct.pack("!H", late[0].getsockname()[1]))
                        if control.recv(1) != b"D":
                            raise RuntimeError("Child did not finish")
                        if proc.wait(timeout=10) != 0 or failures or hits != ["HOST", "LATE_HOST"]:
                            raise RuntimeError(f"Probe failed: {failures}; hits={hits}")
                    finally:
                        done.set()
                        listener.close()
                        worker.join(6)
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=5)
                for listener, stopped, worker in services:
                    stopped.set()
                    listener.close()
                    worker.join(2)


if __name__ == "__main__":
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("Native transport experiment requires a disposable GitHub Actions host")
    if sys.argv[1:2] == ["--child"]:
        child(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5])
    else:
        parent()
