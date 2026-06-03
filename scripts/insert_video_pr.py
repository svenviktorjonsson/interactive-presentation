from pathlib import Path

path = Path("presentations/default/presentation.pr")
video = "video[id=t_video,src=https://www.youtube.com/watch?v=JgJABtXhUiY,thumbnail=00:04.50]"
lines = path.read_text(encoding="utf-8").splitlines()
if video not in lines:
    out = []
    inserted = False
    for line in lines:
        out.append(line)
        if line.strip() == "text[id=view3_note,align=left]: View 3 secondary text":
            out.append(video)
            inserted = True
    if not inserted:
        out.append(video)
    path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
