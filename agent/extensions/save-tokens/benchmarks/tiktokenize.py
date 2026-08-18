#!/usr/bin/env python3
"""Tokenize fixture lines from stdin and emit tiktoken counts as JSON.

Reads one JSON array of strings on stdin, prints a JSON array of
``{"cl100k": int, "o200k": int}`` objects (same order) on stdout.

Used by ``token-calibration.ts`` as a real-tokenizer ground truth for the
local ``estimateTokens`` heuristic. Kept as a standalone file so the Python
side stays auditable and is not embedded as a string in the TS runner.

Run with the headroom venv interpreter (has ``tiktoken>=0.5.0``):
    headroom-source/.venv/bin/python tokenize.py
"""

import json
import sys

import tiktoken

CL100K = tiktoken.get_encoding("cl100k_base")
O200K = tiktoken.get_encoding("o200k_base")


def main() -> None:
    payload = json.load(sys.stdin)
    out = []
    for text in payload:
        out.append(
            {
                "cl100k": len(CL100K.encode(text)),
                "o200k": len(O200K.encode(text)),
            }
        )
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
