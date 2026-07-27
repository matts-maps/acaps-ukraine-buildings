"""
Summarises damaged buildings per Oblast and per Raion, broken down by
building type, with a total per admin unit.

Outputs:
  - data/damage-summary-oblast.csv   (long format, one row per oblast/week/building type + a "Total" row)
  - data/damage-summary-raion.csv    (same, at raion level)
  - data/damage-summary-oblast-shapefile.zip  (.shp/.shx/.dbf/.prj bundle, latest complete week snapshot)
  - data/damage-summary-raion-shapefile.zip   (same, at raion level)

A "week" runs Monday to Sunday. The shapefiles are a wide-format snapshot
(one row per admin polygon, one column per building type + Total) for the
most recently *completed* Monday-Sunday week in the data, since a shapefile
attribute table can't hold a full time series per feature. The CSVs hold
the full weekly time series in long format.
"""

import json
import os
import re
import unicodedata
import zipfile
from datetime import datetime, timezone

import pandas as pd

try:
    import shapefile  # pyshp
except ImportError:
    shapefile = None

INPUT_FILE = "data/ukraine-damages.csv"

OBLAST_GEOJSON = "data/ukr_admn_ad1_py_s0_fieldmaps_pp_oblast.json"
RAION_GEOJSON = "data/ukr_admn_ad2_py_s0_fieldmaps_pp_raions.json"

# Column names as used elsewhere in this repo (see assets/js/raion_analysis.js
# and assets/js/map-visualisations.js). Kept as constants here so they only
# need updating in one place if the ACAPS schema changes.
OBLAST_FIELD = "oblast"
RAION_FIELD = "rayon"
BUILDING_TYPE_FIELD = "type_of_infrastructure"
DATE_FIELD = "date_of_event"

GEOJSON_OBLAST_PROPERTY = "adm1_name"
GEOJSON_RAION_PROPERTY = "adm2_name"

# Raion boundary/CSV spelling mismatches, kept in sync with the
# RAION_NAME_MAP in assets/js/raion_analysis.js.
RAION_NAME_MAP = {
    "Kerchynskyi": "Kerchenskyi",
    "Krasnoperekopskyi": "Perekopskyi",
    "Chervonohradskyi": "Sheptytskyi",
    "Sievierodonetskyi": "Siverskodonetskyi",
}

OUT_DIR = "data"
OBLAST_CSV = f"{OUT_DIR}/damage-summary-oblast.csv"
RAION_CSV = f"{OUT_DIR}/damage-summary-raion.csv"
OBLAST_SHP_ZIP = f"{OUT_DIR}/damage-summary-oblast-shapefile.zip"
RAION_SHP_ZIP = f"{OUT_DIR}/damage-summary-raion-shapefile.zip"


def normalise_name(name):
    """Loose comparison key: strip accents/apostrophes/case/spacing so minor
    spelling differences between the CSV and the boundary geoJSON don't
    prevent a match (e.g. apostrophes in transliterated names)."""
    if not isinstance(name, str):
        return ""
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z]", "", n.lower())


def load_damage_data():
    if not os.path.exists(INPUT_FILE):
        raise FileNotFoundError(f"'{INPUT_FILE}' not found. Run scripts/update.py first.")

    df = pd.read_csv(INPUT_FILE)
    if df.empty:
        raise ValueError("Damage dataset is empty. Nothing to summarise.")

    if DATE_FIELD not in df.columns:
        raise KeyError(f"'{DATE_FIELD}' column not found in {INPUT_FILE}.")

    df[DATE_FIELD] = pd.to_datetime(df[DATE_FIELD], errors="coerce")
    df = df.dropna(subset=[DATE_FIELD])

    for col in (OBLAST_FIELD, RAION_FIELD):
        if col not in df.columns:
            raise KeyError(
                f"'{col}' column not found in {INPUT_FILE}. "
                f"Available columns: {list(df.columns)}"
            )
    df = df.dropna(subset=[OBLAST_FIELD, RAION_FIELD])

    if BUILDING_TYPE_FIELD not in df.columns:
        print(f"Warning: '{BUILDING_TYPE_FIELD}' column not found; all rows will be 'Unspecified'.")
        df[BUILDING_TYPE_FIELD] = "Unspecified"
    df[BUILDING_TYPE_FIELD] = df[BUILDING_TYPE_FIELD].fillna("Unspecified")
    df.loc[df[BUILDING_TYPE_FIELD].astype(str).str.strip() == "", BUILDING_TYPE_FIELD] = "Unspecified"

    # Monday-to-Sunday week bounds for every record.
    weekday = df[DATE_FIELD].dt.weekday  # Monday == 0
    df["week_start"] = (df[DATE_FIELD] - pd.to_timedelta(weekday, unit="D")).dt.date
    df["week_end"] = (df[DATE_FIELD] - pd.to_timedelta(weekday, unit="D") + pd.Timedelta(days=6)).dt.date

    return df


def build_weekly_summary(df, group_field):
    """Long-format weekly summary: one row per admin unit/week/building type,
    plus one 'Total' row per admin unit/week."""
    by_type = (
        df.groupby([group_field, "week_start", "week_end", BUILDING_TYPE_FIELD])
        .size()
        .reset_index(name="damaged_buildings")
        .rename(columns={BUILDING_TYPE_FIELD: "building_type"})
    )

    totals = (
        df.groupby([group_field, "week_start", "week_end"])
        .size()
        .reset_index(name="damaged_buildings")
    )
    totals["building_type"] = "Total"

    combined = pd.concat([by_type, totals], ignore_index=True)
    combined = combined[[group_field, "week_start", "week_end", "building_type", "damaged_buildings"]]
    combined = combined.sort_values(
        by=["week_start", group_field, "building_type"],
        ascending=[False, True, True],
    )
    return combined


def latest_week_pivot(df, group_field):
    """Wide-format snapshot for the most recently *completed* week: one row
    per admin unit, one column per building type, plus a Total column.

    Since this runs daily, the "latest week in the data" would often still
    be in progress. We only consider weeks whose Sunday has already passed,
    so the snapshot always reflects a full Monday-Sunday period."""
    today = datetime.now(timezone.utc).date()
    completed = df[df["week_end"] < today]
    if completed.empty:
        completed = df  # fall back to whatever we have (e.g. brand-new dataset)
    latest_week_end = completed["week_end"].max()
    week_df = df[df["week_end"] == latest_week_end]

    pivot = (
        week_df.groupby([group_field, BUILDING_TYPE_FIELD])
        .size()
        .unstack(fill_value=0)
    )
    pivot["Total"] = pivot.sum(axis=1)
    pivot = pivot.reset_index()
    return pivot, latest_week_end


def shp_safe_fieldname(name, used):
    """Shapefile DBF field names must be <=10 chars and unique."""
    base = re.sub(r"[^A-Za-z0-9_]", "", str(name))[:10] or "FLD"
    candidate = base
    i = 1
    while candidate in used:
        suffix = str(i)
        candidate = (base[: 10 - len(suffix)] if len(base) > 10 - len(suffix) else base) + suffix
        i += 1
    used.add(candidate)
    return candidate


def signed_area(ring):
    s = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[i + 1][0], ring[i + 1][1]
        s += (x1 * y2 - x2 * y1)
    return s / 2.0


def fix_ring_orientation(rings):
    """Shapefiles need exterior rings clockwise and holes counter-clockwise
    (the opposite convention to GeoJSON), or many GIS tools will misread
    holes as separate polygons."""
    fixed = []
    for i, ring in enumerate(rings):
        area = signed_area(ring)
        is_hole = i > 0
        if is_hole and area < 0:
            ring = list(reversed(ring))
        elif not is_hole and area > 0:
            ring = list(reversed(ring))
        fixed.append(ring)
    return fixed


def write_geometry(writer, geom):
    gtype = geom["type"]
    coords = geom["coordinates"]
    parts = []
    if gtype == "Polygon":
        parts.extend(fix_ring_orientation(coords))
    elif gtype == "MultiPolygon":
        for poly in coords:
            parts.extend(fix_ring_orientation(poly))
    else:
        raise ValueError(f"Unsupported geometry type for shapefile export: {gtype}")
    writer.poly(parts)


def write_shapefile(pivot_df, geojson_path, geojson_property, group_field, out_zip_path):
    if shapefile is None:
        print("pyshp not installed - skipping shapefile export. Add 'pyshp' to scripts/requirements.txt.")
        return

    if not os.path.exists(geojson_path):
        print(f"Boundary file '{geojson_path}' not found - skipping shapefile export for {group_field}.")
        return

    with open(geojson_path, encoding="utf-8") as f:
        geo = json.load(f)

    building_type_cols = [c for c in pivot_df.columns if c != group_field]

    lookup = {}
    for _, row in pivot_df.iterrows():
        key = normalise_name(row[group_field])
        lookup[key] = row

    os.makedirs(OUT_DIR, exist_ok=True)
    tmp_base = out_zip_path[: -len(".zip")]

    writer = shapefile.Writer(tmp_base, shapeType=shapefile.POLYGON)
    writer.autoBalance = 1

    writer.field("NAME", "C", size=100)
    field_map = {}
    used_fieldnames = {"NAME"}
    for col in building_type_cols:
        safe = shp_safe_fieldname(col, used_fieldnames)
        field_map[col] = safe
        writer.field(safe, "N", size=10)

    unmatched = []
    for feature in geo["features"]:
        props = feature.get("properties", {})
        raw_name = props.get(geojson_property, "")
        mapped_name = RAION_NAME_MAP.get(raw_name, raw_name) if geojson_property == GEOJSON_RAION_PROPERTY else raw_name
        key = normalise_name(mapped_name)
        row = lookup.get(key)

        write_geometry(writer, feature["geometry"])

        if row is None:
            unmatched.append(raw_name)
            attrs = [mapped_name] + [0] * len(building_type_cols)
        else:
            attrs = [mapped_name] + [int(row[c]) for c in building_type_cols]
        writer.record(*attrs)

    writer.close()

    # WGS84 .prj — the boundary geoJSON is in plain lat/long.
    with open(tmp_base + ".prj", "w") as prj:
        prj.write(
            'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
            'SPHEROID["WGS_1984",6378137,298.257223563]],'
            'PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]'
        )

    with zipfile.ZipFile(out_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for ext in (".shp", ".shx", ".dbf", ".prj"):
            path = tmp_base + ext
            if os.path.exists(path):
                zf.write(path, arcname=os.path.basename(path))
                os.remove(path)

    if unmatched:
        print(
            f"Warning: {len(unmatched)} boundary feature(s) in {geojson_path} had no matching "
            f"damage data (0 written) - e.g. {unmatched[:5]}. If these are real admin units with "
            f"damage, add a spelling correction to RAION_NAME_MAP / the oblast equivalent."
        )

    print(f"Saved shapefile bundle to {out_zip_path}")


def main():
    df = load_damage_data()
    os.makedirs(OUT_DIR, exist_ok=True)

    oblast_summary = build_weekly_summary(df, OBLAST_FIELD)
    raion_summary = build_weekly_summary(df, RAION_FIELD)

    oblast_summary.to_csv(OBLAST_CSV, index=False)
    raion_summary.to_csv(RAION_CSV, index=False)
    print(f"Saved {len(oblast_summary)} rows to {OBLAST_CSV}")
    print(f"Saved {len(raion_summary)} rows to {RAION_CSV}")

    oblast_pivot, oblast_week_end = latest_week_pivot(df, OBLAST_FIELD)
    raion_pivot, raion_week_end = latest_week_pivot(df, RAION_FIELD)
    print(f"Latest complete week ending: oblast={oblast_week_end}, raion={raion_week_end}")

    write_shapefile(oblast_pivot, OBLAST_GEOJSON, GEOJSON_OBLAST_PROPERTY, OBLAST_FIELD, OBLAST_SHP_ZIP)
    write_shapefile(raion_pivot, RAION_GEOJSON, GEOJSON_RAION_PROPERTY, RAION_FIELD, RAION_SHP_ZIP)


if __name__ == "__main__":
    main()
