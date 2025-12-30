"""Generate two interactive plots using field-viewer."""

from pathlib import Path

from field_viewer import FieldViewer


# Raw data from the flask experiment.
ROWS = [
    # mass, h, f_A, f_M
    (1344, 51, 1312, 1968),
    (1323, 86, 703, 1968),
    (1316, 94, 609, 1968),
    (1298, 110, 445, 1968),
    (1270, 124, 352, 1992),
    (1246, 131, 328, 1992),
    (1223, 140, 281, 2015),
    (1190, 150, 258, 2039),
    (1126, 165, 210, 2109),
    (1092, 170, 210, 2133),
    (1043, 182, 187, 2227),
    (1000, 190, 164, 2320),
    (959, 201, 164, 2438),
    (910, 210, 141, 2554),
    (846, 225, 141, 2789),
    (807, 237, 141, 2906),
    (784, 241, 141, 2953),
]

# Build series for each plot.
mass = [row[0] for row in ROWS]
h = [row[1] for row in ROWS]
f_m = [row[3] for row in ROWS]

h_fa = []
f_a = []
for _, h_val, f_a_val, _ in ROWS:
    if f_a_val is None:
        continue
    h_fa.append(h_val)
    f_a.append(f_a_val)


def main() -> None:
    viewer = FieldViewer()
    # Defaults for red-filled vertices and no connecting edges.
    viewer.set(vertex_color="red", vertex_size=10, edge_width=0, vertex_glyph="circle")

    # f_AIR vs h
    viewer.add(x_i=h_fa, y_i=f_a, legend="f_AIR(h)")
    viewer.push(title="f_AIR vs h", labels={"x": "h", "y": "f_AIR"})

    # f_M vs mass
    viewer.add(x_i=mass, y_i=f_m, legend="f_M(mass)")
    viewer.push(title="f_M vs mass", labels={"x": "mass", "y": "f_M"})

    output = Path(__file__).with_name("plots.html")
    viewer.save(output.as_posix())
    print(f"Saved interactive plots to {output}")


if __name__ == "__main__":
    main()

