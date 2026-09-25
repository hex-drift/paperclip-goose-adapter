#!/usr/bin/env python3
"""Read bounded, checksummed pages of the run's assigned instructions."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

MAX_BYTES = 36_000
MAX_LINES = 1_200


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(manifest_path):
    root = manifest_path.resolve(strict=True).parent
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("version") != 1:
        raise ValueError("Unsupported instruction manifest version")
    docs = {d["id"]: d for d in manifest["documents"]}
    texts = {}
    for key, doc in docs.items():
        file = (root / doc["file"]).resolve(strict=True)
        if not file.is_relative_to(root):
            raise ValueError("Instruction file escapes manifest root")
        raw = file.read_bytes()
        if digest(raw) != doc["sha256"]:
            raise ValueError(f"Instruction checksum changed: {key}")
        texts[key] = raw.decode("utf-8").splitlines(keepends=True)
    return manifest, docs, texts


def selection_chunks(selectors, docs, texts):
    chunks = []
    for selector in selectors:
        key, _, suffix = selector.partition(":")
        if key not in docs:
            raise ValueError(f"Unknown document ID: {key}")
        doc = docs[key]
        selected = {int(x) for x in suffix.split(",")} if suffix else {s["id"] for s in doc["sections"]}
        if not selected <= {s["id"] for s in doc["sections"]}:
            raise ValueError(f"Unknown section in {selector}")
        for section in doc["sections"]:
            if section["id"] not in selected:
                continue
            chunks.append(f"\nDOCUMENT {key} sha256:{doc['sha256']} SECTION {section['id']} {section['title']} lines={section['start']}-{section['end']}\n")
            for number in range(section["start"], section["end"] + 1):
                chunks.append(texts[key][number - 1])
    return chunks


def pages(chunks):
    """Bound UTF-8 bytes as well as lines, including the giant-single-line case."""
    output, current = [], ""
    byte_count, line_count = 0, 0
    for chunk in chunks:
        for char in chunk:
            # The cached sizes avoid quadratic work on ordinary paragraphs.
            size = len(char.encode("utf-8"))
            if byte_count + size > MAX_BYTES or (char == "\n" and line_count >= MAX_LINES):
                output.append(current)
                current, byte_count, line_count = "", 0, 0
            current += char
            byte_count += size
            line_count += char == "\n"
    if current or not output:
        output.append(current)
    return output


def render(args):
    manifest_path = Path(args.manifest or os.environ["PAPERCLIP_INSTRUCTION_MANIFEST"])
    manifest, docs, texts = load(manifest_path)
    if args.command == "index":
        selected = [docs[args.doc]] if args.doc else list(docs.values())
        chunks = [f"{d['id']} sha256:{d['sha256']} bytes={d['bytes']}\n" + "\n".join(
            f"  {s['id']}: {s['title']} lines={s['start']}-{s['end']}" for s in d["sections"]) + "\n" for d in selected]
    else:
        chunks = selection_chunks(args.select, docs, texts)
    result = pages(chunks)
    if not 1 <= args.page <= len(result):
        raise ValueError("Page out of range")
    content = result[args.page - 1]
    selection = digest("".join(chunks).encode())
    if args.expect and args.expect != selection:
        raise ValueError("Instruction selection changed between pages")
    next_page = None
    if args.page < len(result):
        next_page = f'python3 "$PAPERCLIP_INSTRUCTION_READER" {args.command}'
        if args.command == "read":
            next_page += " --select " + " ".join(args.select)
        elif args.doc:
            next_page += " --doc " + args.doc
        next_page += f" --page {args.page + 1} --expect {selection}"
    header = {"version": 1, "manifest": manifest["digest"], "selection_sha256": selection,
              "page": args.page, "pages": len(result), "body_bytes": len(content.encode()),
              "selection_byte_offset": sum(len(p.encode()) for p in result[:args.page - 1]),
              "selection_bytes": sum(len(p.encode()) for p in result),
              "body_sha256": digest(content.encode()), "complete": next_page is None,
              "next_page": next_page}
    text = f"BEGIN_PAGE {args.page}/{len(result)} {selection}\n" + json.dumps(header) + "\n" + content
    text += f"\nEND_PAGE {args.page}/{len(result)} {selection}\n"
    if len(text.encode()) >= 48_000 or len(text.splitlines()) >= 1_900:
        raise ValueError("Instruction response envelope exceeds limit")
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["index", "read"])
    parser.add_argument("--manifest")
    parser.add_argument("--doc")
    parser.add_argument("--select", nargs="+", default=[])
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--expect")
    args = parser.parse_args()
    if args.command == "read" and not args.select:
        parser.error("read requires --select")
    print(render(args), end="")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"INSTRUCTION_READ_FAILED: {error}", file=sys.stderr)
        sys.exit(1)
