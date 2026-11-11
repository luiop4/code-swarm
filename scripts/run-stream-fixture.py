"""Run the user's generator against an isolated test target, preserving its source."""
import runpy
import sys
from pathlib import Path

source = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()
workspace = (Path.cwd() / '.vscode-test').resolve()
target.relative_to(workspace)  # Refuse desktop or arbitrary output locations.
speed = sys.argv[3] if len(sys.argv) > 3 else 'normal'
namespace = runpy.run_path(str(source), run_name='swarm_isolated_fixture')
pipeline = namespace['run_streaming_pipeline']
pipeline.__globals__['TARGET_FILE'] = str(target)
sys.argv = [str(source), '--speed', speed]
pipeline()
