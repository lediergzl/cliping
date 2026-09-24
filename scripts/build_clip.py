#!/usr/bin/env python3
"""
Construye el clip final aplicando efectos (v2) a partir de los segmentos ya
descargados por yt-dlp (clips/segment_XXX.mp4) y del payload.json original.

Uso: python3 build_clip.py payload.json clips/ output.mp4

Simplificaciones asumidas (documentadas también en el README):
- El título ("title") solo se superpone durante el primer segmento del clip
  final, no a lo largo de todos los trozos.
- fade_in/fade_out se aplican sobre el primer/último segmento en base a su
  propia duración (antes de acortar por transiciones), es una aproximación
  razonable salvo que el fade dure casi lo mismo que la transición contigua.
- Todos los segmentos procesados comparten resolución y fps exactos
  (requisito de ffmpeg para poder concatenar/cruzar con xfade).
"""
import json
import subprocess
import sys
from pathlib import Path

FPS = 30
TITLE_SECONDS = 5
CANVAS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}


def sh(cmd):
    print("+ " + " ".join(str(c) for c in cmd), flush=True)
    subprocess.run(cmd, check=True)


def probe(path, entry):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", f"stream={entry}",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return out.stdout.strip().splitlines()[0]


def duration_of(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def esc_text(t: str) -> str:
    return (t.replace("\\", "\\\\").replace(":", "\\:")
              .replace("'", "\u2019").replace("%", "\\%"))


def y_expr(position: str) -> str:
    return {"top": "40", "center": "(h-text_h)/2", "bottom": "h-text_h-40"}.get(position, "h-text_h-40")


def has_effects(payload: dict) -> bool:
    out = payload.get("output") or {}
    if (out.get("aspect_ratio") or "original") != "original":
        return True
    if (out.get("fade_in") or 0) > 0 or (out.get("fade_out") or 0) > 0:
        return True
    if out.get("normalize_audio"):
        return True
    if out.get("title") or out.get("watermark"):
        return True
    for seg in payload.get("segments", []):
        if seg.get("zoom"):
            return True
        tr = seg.get("transition")
        if tr and tr.get("type") not in (None, "none"):
            return True
    return False


def build_segment_filter(aspect, canvas, zoom, watermark, title, fade_in, fade_out,
                          is_first, is_last, src_w, src_h, seg_dur):
    w, h = canvas if canvas else (src_w, src_h)
    steps = []

    if canvas and aspect == "16:9":
        steps.append(f"[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
                      f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black[vaspect]")
        vlabel = "[vaspect]"
    elif canvas:  # 9:16 o 1:1: fondo difuminado + primer plano centrado
        steps.append(
            f"[0:v]split=2[bgsrc][fgsrc];"
            f"[bgsrc]scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h},gblur=sigma=20[bgblur];"
            f"[fgsrc]scale={w}:-2:force_original_aspect_ratio=decrease[fgscaled];"
            f"[bgblur][fgscaled]overlay=(W-w)/2:(H-h)/2[vaspect]"
        )
        vlabel = "[vaspect]"
    else:
        steps.append(f"[0:v]null[vaspect]")
        vlabel = "[vaspect]"

    cur = vlabel
    if zoom and zoom.get("factor", 1) > 1:
        factor = float(zoom["factor"])
        if zoom.get("kenburns"):
            frames = max(1, round(seg_dur * FPS))
            step = (factor - 1) / frames
            steps.append(
                f"{cur}fps={FPS},zoompan=z='min(zoom+{step:.6f},{factor})':"
                f"d={frames}:s={w}x{h}:fps={FPS}[vzoom]"
            )
        else:
            steps.append(
                f"{cur}crop=iw/{factor}:ih/{factor}:(iw-iw/{factor})/2:(ih-ih/{factor})/2,"
                f"scale={w}:{h}[vzoom]"
            )
        cur = "[vzoom]"
    else:
        steps.append(f"{cur}fps={FPS}[vzoom]")
        cur = "[vzoom]"

    if watermark and watermark.get("text"):
        y = y_expr(watermark.get("position", "bottom"))
        steps.append(
            f"{cur}drawtext=text='{esc_text(watermark['text'])}':"
            f"fontcolor=white@0.8:fontsize=28:x=(w-text_w)/2:y={y}:"
            f"box=1:boxcolor=black@0.35:boxborderw=8[vwm]"
        )
        cur = "[vwm]"

    if is_first and title and title.get("text"):
        y = y_expr(title.get("position", "bottom"))
        if title.get("duration") == "full":
            enable = ""
        else:
            enable = f":enable='lt(t,{TITLE_SECONDS})'"
        steps.append(
            f"{cur}drawtext=text='{esc_text(title['text'])}':"
            f"fontcolor=white:fontsize=42:x=(w-text_w)/2:y={y}:"
            f"box=1:boxcolor=black@0.5:boxborderw=12{enable}[vtitle]"
        )
        cur = "[vtitle]"

    if is_first and fade_in > 0:
        steps.append(f"{cur}fade=t=in:st=0:d={fade_in}[vfi]")
        cur = "[vfi]"
    if is_last and fade_out > 0:
        st = max(0, seg_dur - fade_out)
        steps.append(f"{cur}fade=t=out:st={st}:d={fade_out}[vfo]")
        cur = "[vfo]"

    steps.append(f"{cur}format=yuv420p[vout]")
    return ";".join(steps), w, h


def build_audio_filter(normalize, is_first, is_last, fade_in, fade_out, seg_dur):
    steps = []
    cur = "[0:a]"
    if normalize:
        steps.append(f"{cur}loudnorm=I=-16:TP=-1.5:LRA=11[anorm]")
        cur = "[anorm]"
    if is_first and fade_in > 0:
        steps.append(f"{cur}afade=t=in:st=0:d={fade_in}[afi]")
        cur = "[afi]"
    if is_last and fade_out > 0:
        st = max(0, seg_dur - fade_out)
        steps.append(f"{cur}afade=t=out:st={st}:d={fade_out}[afo]")
        cur = "[afo]"
    if cur == "[0:a]":
        steps.append("[0:a]anull[aout]")
    else:
        steps.append(f"{cur}anull[aout]")
    return ";".join(steps)


def process_segment(src, dst, payload_output, seg_effects, is_first, is_last):
    aspect = payload_output.get("aspect_ratio") or "original"
    canvas = CANVAS.get(aspect)
    src_w = int(probe(src, "width"))
    src_h = int(probe(src, "height"))
    seg_dur = duration_of(src)

    vfilter, w, h = build_segment_filter(
        aspect, canvas, seg_effects.get("zoom"),
        payload_output.get("watermark"), payload_output.get("title"),
        float(payload_output.get("fade_in") or 0), float(payload_output.get("fade_out") or 0),
        is_first, is_last, src_w, src_h, seg_dur,
    )
    afilter = build_audio_filter(
        bool(payload_output.get("normalize_audio")), is_first, is_last,
        float(payload_output.get("fade_in") or 0), float(payload_output.get("fade_out") or 0), seg_dur,
    )

    sh([
        "ffmpeg", "-y", "-i", str(src),
        "-filter_complex", vfilter + ";" + afilter,
        "-map", "[vout]", "-map", "[aout]",
        "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        str(dst),
    ])
    return w, h


def combine(proc_files, segments, output_path):
    n = len(proc_files)
    if n == 1:
        # ✅ FIX: recodificamos también con 1 solo segmento para garantizar
        # compatibilidad total del archivo final (evita problemas de timestamps
        # o contenedores raros al hacer solo -c copy).
        sh([
            "ffmpeg", "-y", "-i", str(proc_files[0]),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k", "-pix_fmt", "yuv420p",
            str(output_path),
        ])
        return

    transitions = []
    for i in range(n - 1):
        tr = segments[i].get("transition") or {}
        ttype = tr.get("type") if tr.get("type") not in (None, "none") else "fade"
        tdur = float(tr.get("duration") or 0.05)  # "sin transición" ≈ corte casi instantáneo
        transitions.append((ttype, tdur))

    durations = [duration_of(p) for p in proc_files]

    inputs = []
    for p in proc_files:
        inputs += ["-i", str(p)]

    filter_parts = []
    v_prev = "[0:v]"
    a_prev = "[0:a]"
    cum = durations[0]
    for i in range(1, n):
        ttype, tdur = transitions[i - 1]
        tdur = min(tdur, durations[i - 1], durations[i]) or 0.05
        offset = max(0.0, cum - tdur)
        v_label = f"v{i}" if i < n - 1 else "vfinal"
        a_label = f"a{i}" if i < n - 1 else "afinal"
        filter_parts.append(
            f"{v_prev}[{i}:v]xfade=transition={ttype}:duration={tdur}:offset={offset}[{v_label}]"
        )
        filter_parts.append(f"{a_prev}[{i}:a]acrossfade=d={tdur}[{a_label}]")
        v_prev, a_prev = f"[{v_label}]", f"[{a_label}]"
        cum = cum - tdur + durations[i]

    sh([
        "ffmpeg", "-y", *inputs,
        "-filter_complex", ";".join(filter_parts),
        "-map", v_prev, "-map", a_prev,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        str(output_path),
    ])


def main():
    payload_path, clips_dir, output_path = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    payload = json.loads(Path(payload_path).read_text())
    output_cfg = payload.get("output") or {}
    segments_cfg = payload.get("segments") or []

    raw_clips = sorted(clips_dir.glob("segment_*.mp4"))
    if not raw_clips:
        print("No hay segmentos descargados en", clips_dir)
        sys.exit(1)

    if not has_effects(payload):
        # Sin efectos: unión directa sin recodificar (ruta rápida de v1).
        concat_list = clips_dir / "concat_list.txt"
        # ✅ FIX: ffmpeg resuelve rutas relativas respecto al propio listado,
        # así que escribimos solo el nombre del archivo (no la ruta completa).
        # Si escribiéramos 'clips/segment_000.mp4' con el listado dentro de
        # clips/, ffmpeg buscaría 'clips/clips/segment_000.mp4' y fallaría.
        concat_list.write_text("".join(f"file '{p.name}'\n" for p in raw_clips))
        sh(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list), "-c", "copy", str(output_path)])
        return

    proc_files = []
    for i, src in enumerate(raw_clips):
        seg_effects = segments_cfg[i] if i < len(segments_cfg) else {}
        dst = clips_dir / f"proc_{i:03d}.mp4"
        process_segment(src, dst, output_cfg, seg_effects, i == 0, i == len(raw_clips) - 1)
        proc_files.append(dst)

    combine(proc_files, segments_cfg, output_path)


if __name__ == "__main__":
    main()
