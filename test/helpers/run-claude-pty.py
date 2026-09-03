import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import fcntl


def write_to_pty(fd, data):
    try:
        os.write(fd, data)
        return True
    except OSError:
        return False


def stop_child(pid, fd):
    try:
        os.close(fd)
    except OSError:
        pass

    for child_signal in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, child_signal)
        except ProcessLookupError:
            return
        for _ in range(10):
            try:
                result, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return
            if result == pid:
                return
            time.sleep(0.05)


def main():
    binary = sys.argv[1]
    prompt = "Reply after thinking."
    timeout_at = time.monotonic() + 25
    pid, fd = pty.fork()

    if pid == 0:
        argv = [
            binary,
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--model",
            "sonnet",
            "--tools",
            "",
        ]
        os.execve(binary, argv, os.environ)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    output = bytearray()
    prompt_sent = False
    submit_at = None
    exit_at = None

    while time.monotonic() < timeout_at:
        readable, _, _ = select.select([fd], [], [], 0.05)
        if readable:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
            os.write(sys.stdout.fileno(), chunk)

        now = time.monotonic()
        if not prompt_sent and "❯".encode() in output:
            write_to_pty(fd, prompt.encode())
            prompt_sent = True
            submit_at = now + 0.2
        elif submit_at is not None and now >= submit_at:
            write_to_pty(fd, b"\r")
            submit_at = None

        if b"MOCK_FINAL_ANSWER" in output and exit_at is None:
            exit_at = now + 0.3
        if exit_at is not None and now >= exit_at:
            break

    if b"MOCK_FINAL_ANSWER" not in output:
        stop_child(pid, fd)
        return 1

    stop_child(pid, fd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
