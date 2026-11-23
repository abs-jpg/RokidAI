#!/usr/bin/env python
"""Extract an approximate lead-vocal melody for 《红色高跟鞋》.

The input is the real vocal/instrumental mix supplied by the app owner. Demucs
is used once to isolate vocals, then librosa's pYIN tracks the monophonic lead
line. The committed catalog stores only the resulting timed MIDI notes, not the
separated vocal recording.

This is an algorithmic transcription, not an official publisher score.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import librosa
import numpy as np
from scipy.ndimage import median_filter


SR = 22050
HOP_LENGTH = 220  # 10 ms at 22.05 kHz.
FRAME_MS = 1000 * HOP_LENGTH / SR
MIN_MIDI = 52
MAX_MIDI = 84
MIN_NOTE_MS = 100
MAX_BRIDGE_GAP_MS = 180
CHART_VERSION = 2


def load_catalog(catalog_path: Path) -> dict:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    song = next((item for item in catalog.get("songs", []) if item.get("id") == "red-high-heels"), None)
    if not song:
        raise RuntimeError("red-high-heels was not found in catalog-extra.json")
    return song


def median_unvoiced(values: np.ndarray, window: int) -> np.ndarray:
    """Return a local median that ignores NaN instead of poisoning the window."""
    result = np.full_like(values, np.nan, dtype=float)
    radius = window // 2
    for index in np.flatnonzero(np.isfinite(values)):
        local = values[max(0, index - radius): index + radius + 1]
        local = local[np.isfinite(local)]
        if local.size:
            result[index] = np.median(local)
    return result


def correct_octaves(midi: np.ndarray) -> np.ndarray:
    corrected = midi.copy()
    for _ in range(2):
        local = median_unvoiced(corrected, 11)
        delta = corrected - local
        octave_down = delta > 6
        octave_up = delta < -6
        corrected[octave_down] -= 12
        corrected[octave_up] += 12
    return corrected


def floor_to_frame(milliseconds: float) -> int:
    return max(0, math.floor(milliseconds / FRAME_MS))


def ceil_to_frame(milliseconds: float) -> int:
    return max(0, math.ceil(milliseconds / FRAME_MS))


def make_notes_for_line(
    start_ms: float,
    end_ms: float,
    times_ms: np.ndarray,
    pitches: np.ndarray,
    probabilities: np.ndarray,
) -> list[dict]:
    first = floor_to_frame(start_ms)
    after_last = min(len(times_ms), ceil_to_frame(end_ms))
    if after_last <= first:
        return []

    local = pitches[first:after_last].copy()
    local_probability = probabilities[first:after_last]
    valid = (
        np.isfinite(local)
        & (local_probability >= 0.25)
        & (local >= MIN_MIDI - 1)
        & (local <= MAX_MIDI + 1)
    )
    if valid.sum() < 5:
        return []

    local = correct_octaves(local)
    smoothed = median_unvoiced(local, 7)

    finite_offsets = smoothed[np.isfinite(smoothed)] - np.rint(smoothed[np.isfinite(smoothed)])
    tuning = float(np.median(finite_offsets)) if finite_offsets.size else 0.0
    if abs(tuning) > 0.3:
        tuning = 0.0
    quantized = np.rint(smoothed - tuning)

    usable = valid & np.isfinite(quantized)
    usable &= (quantized >= MIN_MIDI) & (quantized <= MAX_MIDI)
    if usable.sum() < 8:
        return []

    # Fill very short analysis holes only when a stable pitch exists on at
    # least one side. Longer gaps remain rests so the guide is not invented.
    filled = quantized.copy()
    valid_indices = np.flatnonzero(usable)
    for left, right in zip(valid_indices[:-1], valid_indices[1:]):
        gap = right - left - 1
        if gap and gap <= 6 and filled[left] == filled[right]:
            filled[left + 1:right] = filled[left]
    usable |= np.isfinite(filled) & (filled >= MIN_MIDI) & (filled <= MAX_MIDI)
    filled[~usable] = np.nan

    notes: list[dict] = []
    index = 0
    while index < len(filled):
        if not np.isfinite(filled[index]):
            index += 1
            continue
        midi = int(filled[index])
        note_start = index
        while index < len(filled) and filled[index] == midi:
            index += 1
        note_end = index
        duration_ms = (note_end - note_start) * FRAME_MS
        confidence = float(np.nanmedian(local_probability[note_start:note_end]))
        if duration_ms >= MIN_NOTE_MS and confidence >= 0.25:
            notes.append({
                "midi": midi,
                "startMs": max(start_ms, times_ms[first + note_start]),
                "endMs": min(end_ms, times_ms[first + note_end - 1] + FRAME_MS),
                "confidence": round(confidence, 3),
            })

    # A one- or two-frame vibrato excursion is noise, not a scored note.
    cleaned: list[dict] = []
    for note in notes:
        if note["endMs"] - note["startMs"] >= MIN_NOTE_MS:
            cleaned.append(note)
        elif cleaned:
            cleaned[-1]["endMs"] = note["endMs"]

    # Coalesce identical adjacent notes and bridge brief consonant gaps in a
    # lyric line. Rests longer than 180 ms remain visible as rests.
    merged: list[dict] = []
    for note in cleaned:
        if merged:
            previous = merged[-1]
            gap = note["startMs"] - previous["endMs"]
            if previous["midi"] == note["midi"] and gap <= MAX_BRIDGE_GAP_MS:
                previous["endMs"] = note["endMs"]
                previous["confidence"] = round(
                    (previous["confidence"] + note["confidence"]) / 2, 3
                )
                continue
            if gap <= 60:
                previous["endMs"] = note["startMs"]
        merged.append(note)

    result = []
    for note in merged:
        start = int(round(note["startMs"] / 10) * 10)
        end = int(round(note["endMs"] / 10) * 10)
        if end - start < MIN_NOTE_MS:
            continue
        if result and start < result[-1]["endMs"]:
            start = result[-1]["endMs"]
        if end - start >= MIN_NOTE_MS:
            result.append({
                "midi": note["midi"],
                "startMs": start,
                "endMs": end,
            })
    return result


def estimate_key(notes: list[dict]) -> str:
    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    chroma = np.zeros(12)
    for note in notes:
        chroma[note["midi"] % 12] += note["endMs"] - note["startMs"]
    if not chroma.any():
        return ""
    chroma /= chroma.sum()
    candidates = []
    for tonic in range(12):
        for mode, profile in (("大调", major), ("小调", minor)):
            rotated = np.roll(profile, tonic)
            score = float(np.corrcoef(chroma, rotated / rotated.sum())[0, 1])
            candidates.append((score, tonic, mode))
    _, tonic, mode = max(candidates)
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    return f"{names[tonic]} {mode}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vocals", required=True, type=Path)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    song = load_catalog(args.catalog)
    audio, sample_rate = librosa.load(args.vocals, sr=SR, mono=True)
    if sample_rate != SR:
        raise RuntimeError(f"unexpected sample rate: {sample_rate}")
    audio = librosa.effects.preemphasis(audio)
    harmonic = librosa.effects.harmonic(audio, margin=2.0)
    f0, voiced, probability = librosa.pyin(
        harmonic,
        fmin=80,
        fmax=1000,
        sr=SR,
        frame_length=2048,
        hop_length=HOP_LENGTH,
        fill_na=np.nan,
        center=True,
    )
    midi = librosa.hz_to_midi(f0)
    times_ms = np.arange(len(f0), dtype=float) * FRAME_MS

    notes = []
    line_count = 0
    for line in song.get("lyrics", []):
        if not str(line.get("text", "")).strip():
            continue
        line_count += 1
        notes.extend(make_notes_for_line(
            float(line["startMs"]),
            float(line["endMs"]),
            times_ms,
            midi,
            probability,
        ))

    notes.sort(key=lambda note: (note["startMs"], note["endMs"]))
    if not notes:
        raise RuntimeError("melody extraction produced no notes")
    for previous, current in zip(notes, notes[1:]):
        if current["startMs"] < previous["endMs"]:
            raise RuntimeError("melody extraction produced overlapping notes")

    duration = float(song["durationMs"])
    if any(note["startMs"] < 0 or note["endMs"] > duration for note in notes):
        raise RuntimeError("melody contains a note outside the song duration")

    lyric_duration = sum(
        max(0, line["endMs"] - line["startMs"])
        for line in song.get("lyrics", [])
        if str(line.get("text", "")).strip()
    )
    note_duration = sum(note["endMs"] - note["startMs"] for note in notes)
    payload = {
        "songId": song["id"],
        "chartVersion": CHART_VERSION,
        "source": {
            "kind": "automatic-vocal-transcription",
            "title": "红色高跟鞋",
            "artist": song.get("artist", ""),
            "audio": "source/red-high-heels.ogg",
            "method": "Demucs vocal isolation + librosa pYIN + octave/semitone cleanup",
            "notice": "算法提取的近似旋律，不是唱片公司或曲谱作者发布的官方谱。",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "estimatedKey": estimate_key(notes),
        "lyricLines": line_count,
        "noteCount": len(notes),
        "noteDurationMs": int(round(note_duration)),
        "lyricCoverage": round(note_duration / lyric_duration, 3) if lyric_duration else 0,
        "notes": notes,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    notes_pitch = np.array([note["midi"] for note in notes])
    durations = np.array([note["endMs"] - note["startMs"] for note in notes])
    print(json.dumps({
        "output": str(args.output),
        "notes": len(notes),
        "lyricLines": line_count,
        "estimatedKey": payload["estimatedKey"],
        "coverage": payload["lyricCoverage"],
        "midiRange": [int(notes_pitch.min()), int(notes_pitch.max())],
        "medianNoteMs": int(np.median(durations)),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
