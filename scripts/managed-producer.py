"""Adapter for stream_coder-style producers; only the private inbox is written."""
from swarm_input import produce_batches
import runpy
import sys
from pathlib import Path

source, inbox = (Path(value).resolve() for value in sys.argv[1:3])
speed = sys.argv[3] if len(sys.argv) > 3 else 'normal'
if inbox.name != 'incoming.txt' or not (inbox.parent / 'before.txt').is_file():
    raise RuntimeError('Expected a prepared Code Swarm input session')
namespace = runpy.run_path(str(source), run_name='swarm_managed_producer')
pipeline = namespace.get('run_streaming_pipeline')
if not callable(pipeline) or 'TARGET_FILE' not in pipeline.__globals__:
    raise RuntimeError('This adapter expects TARGET_FILE and run_streaming_pipeline')
def checkpoint():
    print("SWARM_BATCH_READY", flush=True)
    if sys.stdin.readline().strip() != "APPLIED":
        raise SystemExit("Animation session interrupted")


sys.argv = [str(source), '--speed', speed]
produce_batches(pipeline, inbox, checkpoint)
