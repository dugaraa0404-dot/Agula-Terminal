"""Copy this overlay into a local clone of Agula-Terminal, without touching agula.py.
Usage: python install_into_agula.py /path/to/Agula-Terminal
"""
from __future__ import annotations
import argparse
import shutil
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('repository', help='Existing AGULA repo root containing agula.py')
    args = parser.parse_args()
    repo = Path(args.repository).expanduser().resolve()
    here = Path(__file__).resolve().parent
    for required in ('agula.py', 'trading/paper_bot.py', 'requirements.txt'):
        if not (repo / required).is_file():
            parser.error(f'Missing existing AGULA file: {repo / required}')
    items = ('render_app.py', 'render.yaml', 'Procfile',
             'render/__init__.py', 'render/trading_api.py', 'render/algo.html',
             'render/README.md', 'tests/test_render_api.py')
    for name in items:
        destination = repo / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(here / name, destination)
        print(f'Installed: {destination}')
    print('Next: pip install -r requirements.txt && uvicorn render_app:app --port 8000')


if __name__ == '__main__':
    main()
