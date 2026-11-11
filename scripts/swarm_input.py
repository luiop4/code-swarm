"""Send complete UTF-8 source snapshots to Code Swarm's watched Windows editor."""
import builtins
import hashlib
import json
import os
import tempfile
from types import SimpleNamespace
from pathlib import Path


def run_managed(pipeline, target):
    key = hashlib.sha256(os.path.abspath(target).lower().encode("utf-8")).hexdigest()
    pipe = rf"\\.\pipe\code-swarm-{key}"
    try:
        channel = builtins.open(pipe, "r+b", buffering=0)
    except OSError as error:
        raise SystemExit(f"Code Swarm is not ready. Watch {target} in VS Code, then retry.") from error

    def expect(message):
        received = channel.readline().decode("utf-8").strip()
        if received != message:
            raise RuntimeError(received or "Code Swarm disconnected")

    with channel, tempfile.TemporaryDirectory(prefix="swarm-input-") as folder:
        expect("READY")
        print("Code Swarm connected. Keep the target editor visible.", flush=True)
        inbox = Path(folder) / "incoming.txt"
        inbox.write_bytes(Path(target).read_bytes() if Path(target).exists() else b"")
        def checkpoint():
            data = json.dumps(inbox.read_text(encoding="utf-8-sig"), ensure_ascii=False)
            payload = (data + "\n").encode("utf-8")
            offset = 0
            while offset < len(payload):
                offset += channel.write(payload[offset:])

        produce_batches(pipeline, inbox, checkpoint)
        channel.write(b"END\n")
        expect("DONE")


def produce_batches(pipeline, inbox, checkpoint):
    class BatchWriter:
        def __init__(self, stream):
            self.stream = stream
            self.count = 0
            self.pending = stream.mode.startswith("w")

        def __enter__(self):
            return self

        def __exit__(self, kind, value, trace):
            self.stream.close()
            if kind is None and self.pending:
                checkpoint()

        def __getattr__(self, name):
            return getattr(self.stream, name)

        def write(self, text):
            length = self.stream.write(text)
            self.count += 1
            self.pending = True
            if self.count >= 4:
                self.stream.flush()
                checkpoint()
                self.count = 0
                self.pending = False
            return length

    def staged_open(path, mode="r", *args, **kwargs):
        stream = builtins.open(path, mode, *args, **kwargs)
        if mode in ("w", "a") and Path(path) == inbox:
            return BatchWriter(stream)
        return stream

    namespace = pipeline.__globals__
    previous_target = namespace["TARGET_FILE"]
    previous_open = namespace.get("open")
    previous_os = namespace["os"]
    previous_time = namespace["time"]
    previous_parse = namespace["parse_speed_args"]
    staged_os = SimpleNamespace(**vars(previous_os))
    staged_os.fsync = lambda _fd: None
    staged_time = SimpleNamespace(**vars(previous_time))
    staged_time.sleep = lambda seconds: previous_time.sleep(min(seconds, 0.36))
    def paced_parse():
        previous_parse()
        namespace["LINE_DELAY"] = max(0.008, min(0.024, namespace["LINE_DELAY"]))
        namespace["SECTION_PAUSE"] = 0
        namespace["DELETE_PAUSE"] = 0.08
        namespace["INSERT_PAUSE"] = 0.08
    namespace.update(TARGET_FILE=str(inbox), open=staged_open, os=staged_os,
                     time=staged_time, parse_speed_args=paced_parse)
    try:
        pipeline()
    finally:
        namespace["TARGET_FILE"] = previous_target
        namespace["os"] = previous_os
        namespace["time"] = previous_time
        namespace["parse_speed_args"] = previous_parse
        if previous_open is None:
            namespace.pop("open", None)
        else:
            namespace["open"] = previous_open
