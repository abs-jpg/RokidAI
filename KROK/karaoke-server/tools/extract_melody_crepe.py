#!/usr/bin/env python
"""Extract a timed vocal melody with the CREPE neural pitch model."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import librosa
import numpy as np
import torch
import torchcrepe

from extract_melody import estimate_key, load_catalog, make_notes_for_line


SAMPLE_RATE = 16000
HOP_LENGTH = 160  # 10 ms


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vocals", required=True, type=Path)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--song-id", required=True)
    parser.add_argument("--chart-version", required=True, type=int)
    parser.add_argument("--confidence", type=float, default=0.05)
    parser.add_argument("--min-note-ms", type=float, default=60)
    parser.add_argument("--bridge-gap-ms", type=float, default=420)
    parser.add_argument("--fmin", type=float, default=65)
    parser.add_argument("--fmax", type=float, default=1400)
    args = parser.parse_args()

    song = load_catalog(args.catalog, args.song_id)
    audio, sample_rate = librosa.load(args.vocals, sr=SAMPLE_RATE, mono=True)
    if sample_rate != SAMPLE_RATE:
        raise RuntimeError(f"unexpected sample rate: {sample_rate}")
    tensor = torch.tensor(audio, dtype=torch.float32).unsqueeze(0)
    frequency, confidence = torchcrepe.predict(
        tensor,
        SAMPLE_RATE,
        hop_length=HOP_LENGTH,
        fmin=args.fmin,
        fmax=args.fmax,
        model="full",
        batch_size=2048,
        device="cpu",
        return_periodicity=True,
    )
    frequency = frequency[0].numpy()
    confidence = confidence[0].numpy()
    midi = librosa.hz_to_midi(frequency)
    times_ms = np.arange(len(frequency), dtype=float) * 1000 * HOP_LENGTH / SAMPLE_RATE

    notes = []
    lyric_lines = 0
    for line in song.get("lyrics", []):
        if not str(line.get("text", "")).strip():
            continue
        lyric_lines += 1
        notes.extend(make_notes_for_line(
            float(line["startMs"]),
            float(line["endMs"]),
            times_ms,
            midi,
            confidence,
            args.confidence,
            args.min_note_ms,
            args.bridge_gap_ms,
        ))

    notes.sort(key=lambda note: (note["startMs"], note["endMs"]))
    if not notes:
        raise RuntimeError("CREPE melody extraction produced no notes")
    for previous, current in zip(notes, notes[1:]):
        if current["startMs"] < previous["endMs"]:
            raise RuntimeError("CREPE extraction produced overlapping notes")

    lyric_duration = sum(
        max(0, line["endMs"] - line["startMs"])
        for line in song.get("lyrics", [])
        if str(line.get("text", "")).strip()
    )
    note_duration = sum(note["endMs"] - note["startMs"] for note in notes)
    payload = {
        "songId": song["id"],
        "chartVersion": args.chart_version,
        "source": {
            "kind": "automatic-vocal-transcription",
            "title": song.get("name", ""),
            "artist": song.get("artist", ""),
            "audio": f"source/{song['id']}.ogg",
            "method": "Demucs vocal isolation + torchcrepe + octave/semitone cleanup",
            "notice": "算法提取的近似旋律，不是唱片公司或曲谱作者发布的官方谱。",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "estimatedKey": estimate_key(notes),
        "lyricLines": lyric_lines,
        "noteCount": len(notes),
        "noteDurationMs": int(round(note_duration)),
        "lyricCoverage": round(note_duration / lyric_duration, 3) if lyric_duration else 0,
        "notes": notes,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "notes": len(notes),
        "lyricLines": lyric_lines,
        "estimatedKey": payload["estimatedKey"],
        "coverage": payload["lyricCoverage"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
