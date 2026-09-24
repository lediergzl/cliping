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

Compatibilidad: la salida SIEMPRE es H.264 (yuv420p) + AAC con faststart, que
es lo que reproducen navegadores, móviles y redes sociales. xfade devuelve
yuv444p si no se fuerza el formato, y ese H.264 4:4:4 no se ve en casi ningún
reproductor (por eso se fuerza yuv420p y se verifica al final).

Audio de fondo (opcional): payload["output"]["audio"] con
  { "path": "music.mp3", "mode": "mix"|"replace", "volume": 0..1,
    "original_volume": 0..1, "start": segundos, "loop": bool, "fade_out": s }
"path" lo deja preparado el workflow (descarga de "url" o fichero de audio/).
"""
import json
import subprocess
import sys
from pathlib import Path

FPS = 30
TITLE_SECONDS = 5
CANVAS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
# El Worker/userscript usan "wipe", pero xfade solo conoce wipeleft, wiperight, etc.
XFADE = {"fade": "fade", "dissolve": "dissolve", "wipe": "wipeleft"}
ENC_V = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
ENC_A = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
FASTSTART = ["-movflags", "+faststart"]
A_FMT = "aformat=sample_rates=48000:channel_layouts=stereo"


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


def stream_info(path, kind, entry):
    """Devuelve el valor de ffprobe para el primer stream de 'kind' (v/a) o None."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", f"{kind}:0",
         "-show_entries", f"stream={entry}",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    lines = out.stdout.strip().splitlines()
    return lines[0] if lines else None


def has_audio(path) -> bool:
    return stream_info(path, "a", "codec_name") is not None


def video_duration(path) -> float:
    """Duración del stream de vídeo (la del contenedor puede ser mayor por el audio)."""
    v = stream_info(path, "v", "duration")
    try:
        return float(v)
    except (TypeError, ValueError):
        return duration_of(path)


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

    if canvas and aspect in ("9:16", "1:1"):
        # Fondo difuminado + primer plano centrado
        steps.append(
            f"[0:v]split=2[bgsrc][fgsrc];"
            f"[bgsrc]scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h},gblur=sigma=20[bgblur];"
            f"[fgsrc]scale={w}:{h}:force_original_aspect_ratio=decrease[fgscaled];"
            f"[bgblur][fgscaled]overlay=(W-w)/2:(H-h)/2[vaspect]"
        )
        vlabel = "[vaspect]"
    elif canvas:
        # 16:9  ó  "original" con canvas común → letterbox/pillarbox
        steps.append(
            f"[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black[vaspect]"
        )
        vlabel = "[vaspect]"
    else:
        # Sin canvas: mantener resolución original (solo se usa si nunca se concatena)
        steps.append("[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2[vaspect]")
        vlabel = "[vaspect]"

    cur = vlabel
    if zoom and zoom.get("factor", 1) > 1:
        factor = float(zoom["factor"])
        if zoom.get("kenburns"):
            # d=1: un fotograma de salida por cada fotograma de entrada. Con
            # d=frames (como estaba) zoompan repite CADA fotograma 'frames'
            # veces y el clip se vuelve N veces más largo (el job no termina).
            # 'on' = nº de fotograma de salida; se centra con x/y.
            frames = max(1, round(seg_dur * FPS))
            steps.append(
                f"{cur}fps={FPS},scale={w * 2}:{h * 2},"
                f"zoompan=z='min(1+({factor}-1)*on/{frames},{factor})':"
                f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
                f"d=1:s={w}x{h}:fps={FPS}[vzoom]"
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

    steps.append(f"{cur}format=yuv420p,setsar=1[vout]")
    return ";".join(steps), w, h


def build_audio_filter(normalize, is_first, is_last, fade_in, fade_out, seg_dur, a_in="[0:a]"):
    steps = []
    cur = a_in
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
    # Mismo formato en todos los trozos (acrossfade lo exige).
    steps.append(f"{cur}{A_FMT}[aout]")
    return ";".join(steps)


def process_segment(src, dst, payload_output, seg_effects, is_first, is_last, common_canvas=None):
    aspect = payload_output.get("aspect_ratio") or "original"
    canvas = common_canvas if common_canvas is not None else CANVAS.get(aspect)
    src_w = int(probe(src, "width"))
    src_h = int(probe(src, "height"))
    seg_dur = duration_of(src)

    vfilter, w, h = build_segment_filter(
        aspect, canvas, seg_effects.get("zoom"),
        payload_output.get("watermark"), payload_output.get("title"),
        float(payload_output.get("fade_in") or 0), float(payload_output.get("fade_out") or 0),
        is_first, is_last, src_w, src_h, seg_dur,
    )
    inputs = ["-i", str(src)]
    a_in = "[0:a]"
    if not has_audio(src):
        # Trozo sin pista de audio: se genera silencio para poder unir/cruzar.
        inputs += ["-f", "lavfi", "-t", f"{seg_dur:.3f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        a_in = "[1:a]"
    afilter = build_audio_filter(
        bool(payload_output.get("normalize_audio")), is_first, is_last,
        float(payload_output.get("fade_in") or 0), float(payload_output.get("fade_out") or 0),
        seg_dur, a_in,
    )

    sh([
        "ffmpeg", "-y", *inputs,
        "-filter_complex", vfilter + ";" + afilter,
        "-map", "[vout]", "-map", "[aout]",
        "-r", str(FPS), *ENC_V, *ENC_A,
        str(dst),
    ])
    return w, h


def combine(proc_files, segments, output_path):
    n = len(proc_files)
    if n == 1:
        # El trozo ya está en H.264/AAC yuv420p: solo se re-empaqueta con faststart.
        sh(["ffmpeg", "-y", "-i", str(proc_files[0]), "-c", "copy", *FASTSTART, str(output_path)])
        return

    # (tipo, duración) por unión; None = corte directo sin transición.
    transitions = []
    for i in range(n - 1):
        tr = (segments[i].get("transition") or {}) if i < len(segments) else {}
        ttype = XFADE.get(tr.get("type"))
        tdur = float(tr.get("duration") or 0)
        transitions.append((ttype, tdur) if ttype and tdur > 0 else None)

    # Duración del VÍDEO de cada trozo: el audio se recorta a esa medida para
    # que no se acumule desfase entre imagen y sonido a lo largo del clip.
    durations = [video_duration(p) for p in proc_files]

    inputs = []
    for p in proc_files:
        inputs += ["-i", str(p)]

    filter_parts = []
    for i in range(n):
        filter_parts.append(f"[{i}:a]atrim=0:{durations[i]:.4f},asetpts=PTS-STARTPTS[at{i}]")

    v_prev = "[0:v]"
    a_prev = "[at0]"
    cum = durations[0]
    for i in range(1, n):
        v_label, a_label = f"v{i}", f"a{i}"
        tr = transitions[i - 1]
        if tr is None:
            # Corte directo: concat (xfade con <2 fotogramas da timestamps inválidos).
            filter_parts.append(f"{v_prev}[{i}:v]concat=n=2:v=1:a=0[{v_label}]")
            filter_parts.append(f"{a_prev}[at{i}]concat=n=2:v=0:a=1[{a_label}]")
            cum += durations[i]
        else:
            ttype, tdur = tr
            tdur = max(0.1, min(tdur, durations[i - 1], durations[i]))
            offset = max(0.0, cum - tdur)
            filter_parts.append(
                f"{v_prev}[{i}:v]xfade=transition={ttype}:duration={tdur}:offset={offset:.4f}[{v_label}]"
            )
            filter_parts.append(f"{a_prev}[at{i}]acrossfade=d={tdur}[{a_label}]")
            cum = cum - tdur + durations[i]
        v_prev, a_prev = f"[{v_label}]", f"[{a_label}]"

    # xfade puede devolver yuv444p: se fuerza yuv420p (imprescindible para que
    # el archivo se vea en navegadores, móviles y reproductores comunes).
    filter_parts.append(f"{v_prev}format=yuv420p,setsar=1[vfinal]")

    sh([
        "ffmpeg", "-y", *inputs,
        "-filter_complex", ";".join(filter_parts),
        "-map", "[vfinal]", "-map", a_prev,
        "-r", str(FPS), *ENC_V, *ENC_A, *FASTSTART,
        str(output_path),
    ])


def is_universal(path) -> bool:
    """H.264 + yuv420p + AAC (o sin audio): se puede copiar sin recodificar."""
    return (stream_info(path, "v", "codec_name") == "h264"
            and stream_info(path, "v", "pix_fmt") == "yuv420p"
            and stream_info(path, "a", "codec_name") in ("aac", None))


def mix_audio(video, cfg, out):
    """Añade/mezcla una pista de audio de fondo sin recodificar el vídeo."""
    music = cfg.get("path")
    if not music or not Path(music).exists():
        print(f"Audio configurado pero no disponible ({music}); revisa el paso de descarga.")
        sys.exit(1)

    dur = duration_of(video)
    vol = min(max(float(cfg.get("volume", 0.5)), 0.0), 1.0)
    orig = min(max(float(cfg.get("original_volume", 1.0)), 0.0), 1.0)
    start = max(float(cfg.get("start") or 0), 0.0)
    fade = min(max(float(cfg.get("fade_out", 2)), 0.0), dur)
    loop = cfg.get("loop", True) is not False
    mode = cfg.get("mode", "mix")

    m = f"[1:a]{A_FMT},volume={vol}"
    if not loop:
        m += ",apad"   # rellena con silencio si la música es más corta
    if fade > 0:
        m += f",afade=t=out:st={max(0.0, dur - fade):.3f}:d={fade}"

    if mode == "mix" and has_audio(video):
        graph = (f"[0:a]{A_FMT},volume={orig}[orig];{m}[music];"
                 f"[orig][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
                 f"alimiter=limit=0.95[aout]")
    else:  # "replace" (o el vídeo no tiene audio): solo suena la música
        graph = f"{m}[aout]"

    cmd = ["ffmpeg", "-y", "-i", str(video)]
    if loop:
        cmd += ["-stream_loop", "-1"]
    if start > 0:
        cmd += ["-ss", f"{start}"]
    cmd += ["-i", str(music), "-filter_complex", graph,
            "-map", "0:v", "-map", "[aout]", "-c:v", "copy", *ENC_A,
            "-t", f"{dur:.3f}", *FASTSTART, str(out)]
    sh(cmd)


def verify_output(path):
    """Falla el job si el archivo no es reproducible de forma universal."""
    vc = stream_info(path, "v", "codec_name")
    pf = stream_info(path, "v", "pix_fmt")
    ac = stream_info(path, "a", "codec_name")
    print(f"Verificación: vídeo={vc}/{pf} audio={ac}", flush=True)
    if vc != "h264" or pf != "yuv420p" or ac not in ("aac", None):
        print("::error::El clip final no es H.264/yuv420p/AAC; no se publica para evitar un archivo que no se ve.")
        sys.exit(1)


def main():
    payload_path, clips_dir, output_path = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    payload = json.loads(Path(payload_path).read_text())
    output_cfg = payload.get("output") or {}
    segments_cfg = payload.get("segments") or []
    audio_cfg = output_cfg.get("audio")

    raw_clips = sorted(clips_dir.glob("segment_*.mp4"))
    if not raw_clips:
        print("No hay segmentos descargados en", clips_dir)
        sys.exit(1)

    # Con música, primero se construye el clip y luego se mezcla el audio.
    built = clips_dir / "built.mp4" if audio_cfg else output_path

    if not has_effects(payload) and all(is_universal(p) for p in raw_clips):
        # Sin efectos y ya en H.264/AAC: unión directa sin recodificar (ruta rápida).
        concat_list = clips_dir / "concat_list.txt"
        # ffmpeg resuelve rutas relativas respecto al propio listado, así que
        # se escribe solo el nombre del archivo.
        concat_list.write_text("".join(f"file '{p.name}'\n" for p in raw_clips))
        sh(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
            "-c", "copy", *FASTSTART, str(built)])
    else:
        # Con efectos, o si yt-dlp entregó VP9/AV1/Opus (no reproducible en muchos
        # sitios): se recodifica a H.264/AAC.
        aspect = output_cfg.get("aspect_ratio") or "original"
        common_canvas = CANVAS.get(aspect)

        if common_canvas is None:
            # "original": detectar si los segmentos tienen resoluciones distintas.
            sizes = set()
            for p in raw_clips:
                w = int(probe(p, "width"))
                h = int(probe(p, "height"))
                sizes.add((w, h))
            if len(sizes) > 1:
                max_w = max(w for w, _ in sizes)
                max_h = max(h for _, h in sizes)
                # redondear a par (yuv420p)
                max_w += max_w % 2
                max_h += max_h % 2
                common_canvas = (max_w, max_h)
                print(f"Resoluciones mixtas detectadas {sizes}; canvas común → {common_canvas}",
                      flush=True)
            else:
                common_canvas = None  # todas iguales, no hace falta forzar nada

        proc_files = []
        for i, src in enumerate(raw_clips):
            seg_effects = segments_cfg[i] if i < len(segments_cfg) else {}
            dst = clips_dir / f"proc_{i:03d}.mp4"
            process_segment(
                src, dst, output_cfg, seg_effects,
                i == 0, i == len(raw_clips) - 1,
                common_canvas,
            )
            proc_files.append(dst)
        combine(proc_files, segments_cfg, built)

    if audio_cfg:
        mix_audio(built, audio_cfg, output_path)

    verify_output(output_path)


if __name__ == "__main__":
    main()
