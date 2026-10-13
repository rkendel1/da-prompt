#!/usr/bin/env python3
"""PTY helper for da-prompt's embedded terminal.

Node has no built-in pseudo-terminal, and the repository has no native dependencies, so the backend runs this tiny
helper (Python 3 standard library only; present with the Xcode command line tools on macOS and on most Linux hosts).
It allocates a real PTY, runs the user's shell on it as a session leader, and relays bytes:

  stdin  (fd 0)  bytes typed by the user            -> written to the PTY master
  stdout (fd 1)  bytes the program wrote to the TTY -> read by the backend
  fd 3           control lines from the backend: "resize COLS ROWS", "signal NAME", "kill"
  fd 4           JSON lines to the backend: {"event":"started","pid":N} / {"event":"exit","code":N,"signal":N|null}

The command is passed as argv after "--" (never through a shell string); the environment is the helper's own;
DA_PTY_CWD, DA_PTY_COLS and DA_PTY_ROWS set the start directory and size.
When the backend goes away (control pipe EOF) the shell's process group is hung up and then killed, so nothing outlives it.
"""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

SIGNALS = {"INT": signal.SIGINT, "QUIT": signal.SIGQUIT, "TERM": signal.SIGTERM, "HUP": signal.SIGHUP, "KILL": signal.SIGKILL, "TSTP": signal.SIGTSTP, "CONT": signal.SIGCONT}
MAX_PENDING_INPUT = 1 << 20


def emit(obj):
    try:
        os.write(4, (json.dumps(obj) + "\n").encode())
    except OSError:
        pass


def process_table():
    """[(pid, ppid, session)] from one `ps` snapshot (Linux and macOS)."""
    try:
        out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,sess="], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return []
    rows = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 3:
            try:
                rows.append((int(parts[0]), int(parts[1]), parts[2]))
            except ValueError:
                pass
    return rows


def session_tree(shell_pid, known=(), sess=None):
    """Everything that belongs to the shell: its descendants and every process still in its login session."""
    rows = process_table()
    sess = next((r[2] for r in rows if r[0] == shell_pid), sess)
    kids = {}
    for pid, ppid, _ in rows:
        kids.setdefault(ppid, []).append(pid)
    found = set(known)
    stack = [shell_pid]
    while stack:
        for k in kids.get(stack.pop(), []):
            if k not in found:
                found.add(k)
                stack.append(k)
    if sess is not None and sess != "0":
        found.update(pid for pid, _, sv in rows if sv == sess)
    found.discard(os.getpid())
    found.discard(shell_pid)
    return found


def signal_all(pids, sig):
    for target in pids:
        try:
            os.kill(target, sig)
        except OSError:
            pass


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        sys.stderr.write("no command\n")
        return 2
    cwd = os.environ.pop("DA_PTY_CWD", None) or os.getcwd()
    cols = int(os.environ.pop("DA_PTY_COLS", "80"))
    rows = int(os.environ.pop("DA_PTY_ROWS", "24"))

    pid, master = pty.fork()
    if pid == 0:  # child: session leader with the PTY slave as its controlling terminal
        try:
            set_size(0, cols, rows)
            os.chdir(cwd)
        except OSError as e:
            sys.stderr.write("da-prompt terminal: cannot start in %s: %s\n" % (cwd, os.strerror(e.errno)))
            os._exit(126)
        try:
            os.execvp(argv[0], argv)
        except OSError as e:
            sys.stderr.write("da-prompt terminal: cannot run %s: %s\n" % (argv[0], os.strerror(e.errno)))
            os._exit(127 if e.errno == errno.ENOENT else 126)

    emit({"event": "started", "pid": pid})
    shell_sess = next((r[2] for r in process_table() if r[0] == pid), None)
    for fd in (master, 0, 3):
        fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
    pending = b""      # input waiting for the PTY to accept it
    outbuf = b""       # PTY output waiting for the backend to read it
    status = None
    ctl = b""
    stdin_open = True
    ctl_open = True
    master_open = True
    killing_at = None
    tree = set()

    def fg_pgrp():
        try:
            return os.tcgetpgrp(master)
        except OSError:
            return pid

    def hang_up():
        nonlocal killing_at, tree
        tree = session_tree(pid, tree, shell_sess)  # snapshot while the shell is alive: children are reparented once it dies
        signal_all(tree, signal.SIGHUP)
        for target in {pid, fg_pgrp()}:
            try:
                os.killpg(target, signal.SIGHUP)
            except OSError:
                pass
        if killing_at is None:
            killing_at = time.monotonic() + 2.0

    def reap():
        nonlocal status
        if status is None:
            try:
                p, st = os.waitpid(pid, os.WNOHANG)
                if p:
                    status = st
            except ChildProcessError:
                status = 0

    while True:
        reap()
        if killing_at is not None and time.monotonic() > killing_at and status is None:
            for target in {pid, fg_pgrp()}:
                try:
                    os.killpg(target, signal.SIGKILL)
                except OSError:
                    pass
            signal_all(tree, signal.SIGKILL)
            killing_at = time.monotonic() + 1.0
        if status is not None and not master_open and not outbuf:
            break
        rl = []
        wl = []
        if master_open and len(outbuf) < (1 << 20):
            rl.append(master)
        if stdin_open and len(pending) < MAX_PENDING_INPUT:
            rl.append(0)
        if ctl_open:
            rl.append(3)
        if pending and master_open:
            wl.append(master)
        if outbuf:
            wl.append(1)
        try:
            r, w, _ = select.select(rl, wl, [], 0.2)
        except InterruptedError:
            continue
        if master in r:
            try:
                data = os.read(master, 65536)
                if data:
                    outbuf += data
                else:
                    master_open = False
            except OSError as e:
                if e.errno in (errno.EIO, errno.EBADF):  # the slave side is closed: the shell is gone
                    master_open = False
                elif e.errno not in (errno.EAGAIN, errno.EINTR):
                    master_open = False
        if 1 in w and outbuf:
            try:
                n = os.write(1, outbuf)
                outbuf = outbuf[n:]
            except BlockingIOError:
                pass
            except OSError:
                hang_up()
                break
        if 0 in r:
            try:
                data = os.read(0, 65536)
                if data:
                    pending += data
                else:
                    stdin_open = False
            except BlockingIOError:
                pass
            except OSError:
                stdin_open = False
        if master in w and pending:
            try:
                n = os.write(master, pending)
                pending = pending[n:]
            except (BlockingIOError, InterruptedError):
                pass
            except OSError:
                pending = b""
        if 3 in r:
            try:
                data = os.read(3, 4096)
            except BlockingIOError:
                data = None
            except OSError:
                data = b""
            if data == b"":
                ctl_open = False
                hang_up()  # the backend is gone or closed us: take the shell down
            elif data:
                ctl += data
                while b"\n" in ctl:
                    line, ctl = ctl.split(b"\n", 1)
                    parts = line.decode("utf-8", "replace").split()
                    try:
                        if parts[:1] == ["resize"] and len(parts) == 3:
                            set_size(master, max(2, min(1000, int(parts[1]))), max(1, min(500, int(parts[2]))))
                        elif parts[:1] == ["signal"] and len(parts) == 2 and parts[1] in SIGNALS:
                            os.killpg(fg_pgrp(), SIGNALS[parts[1]])
                        elif parts[:1] == ["kill"]:
                            hang_up()
                    except (OSError, ValueError):
                        pass
        if status is not None and master_open:
            # The shell has exited; anything it left behind keeps the PTY open. Stop once output has drained.
            if not r and not outbuf:
                master_open = False

    # Leave nothing behind in the shell's session (background jobs, grandchildren, stubborn processes).
    tree = session_tree(pid, tree, shell_sess)
    signal_all(tree, signal.SIGHUP)
    for target in {pid}:
        try:
            os.killpg(target, signal.SIGKILL)
        except OSError:
            pass
    if tree:
        time.sleep(0.3)
        signal_all(tree, signal.SIGKILL)
    reap()
    code = None
    sig = None
    if status is not None:
        if os.WIFEXITED(status):
            code = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            sig = os.WTERMSIG(status)
    emit({"event": "exit", "code": code, "signal": sig})
    return 0


if __name__ == "__main__":
    sys.exit(main())
