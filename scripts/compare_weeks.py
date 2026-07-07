import os
import pandas as pd
import matplotlib
matplotlib.use('Agg')  # Required for headless/GitHub Action environments
import matplotlib.pyplot as plt

INPUT_FILE = "data/ukraine-damages.csv"
OUTPUT_GRAPH = "data/week_4_comparison.png"
OUTPUT_CSV = "data/week_4_comparison.csv"

def generate_weekly_comparison_chart():
    if not os.path.exists(INPUT_FILE):
        print(f"Error: '{INPUT_FILE}' not found. Please run the update script first.")
        return

    print(f"Reading data from {INPUT_FILE}...")
    df = pd.read_csv(INPUT_FILE)
    
    if df.empty:
        print("Dataset is empty. Skipping analysis.")
        return

    # 1. Prepare Datetime & Extract Time Units
    df["date_of_event"] = pd.to_datetime(df["date_of_event"], errors="coerce")
    df = df.dropna(subset=["date_of_event"])

    df["iso_year"] = df["date_of_event"].dt.isocalendar().year
    df["iso_week"] = df["date_of_event"].dt.isocalendar().week

    # 2. Aggregate Data: Count damages grouped by Year and Week Number
    # This forms a full continuous calendar matrix
    summary_matrix = (
        df.groupby(["iso_year", "iso_week"])
        .size()
        .reset_index(name="damaged_buildings")
    )

    # Save matrix data to CSV for downstream use or auditing
    summary_matrix.to_csv(OUTPUT_CSV, index=False)

    # 3. Setup the Visual Canvas (matching dashboard style)
    fig, ax = plt.subplots(figsize=(12, 6.5), facecolor="#f8f9fa")
    ax.set_facecolor("#ffffff")

    # Establish an elegant color palette for the lines (e.g., 2024, 2025, 2026)
    # The last year (current year) will stand out in an orange accent tone
    years = sorted(summary_matrix["iso_year"].unique())
    base_colors = ["#1e3d59", "#17b978", "#e67e22", "#9b59b6"] # Dark blue, green, orange, purple
    
    # Map colors dynamically so the most recent year is always orange
    color_map = {year: base_colors[i % len(base_colors)] for i, year in enumerate(years)}
    if len(years) >= 2:
        color_map[years[-1]] = "#d35400" # Strong accent orange for the current year line

    # 4. Plot each year's time-series line
    for year in years:
        year_data = summary_matrix[summary_matrix["iso_year"] == year].sort_values("iso_week")
        
        ax.plot(
            year_data["iso_week"], 
            year_data["damaged_buildings"], 
            label=str(year),
            color=color_map[year],
            linewidth=2.5,
            marker='o',
            markersize=5,
            markerfacecolor='#ffffff',
            markeredgewidth=2
        )

    # 5. Fine-tune Axes & Labels to match the clean dashboard reference image
    ax.set_title("Damaged Buildings per Week — Year over Year Comparison", 
                 fontsize=14, fontweight="bold", pad=20, color="#1e293b", loc="left")
    ax.set_xlabel("Calendar Week (ISO Week Number)", fontsize=11, labelpad=12, color="#475569")
    ax.set_ylabel("Number of Damaged Buildings", fontsize=11, labelpad=12, color="#475569")

    # Set cleaner x-ticks intervals (showing every 4 weeks to keep it scannable)
    ax.set_xticks(range(1, 54, 4))
    ax.set_xlim(0.5, 53.5)
    ax.set_ylim(bottom=0)

    # Style borders (spines) and grid lines
    for spine in ["top", "right", "left", "bottom"]:
        ax.spines[spine].set_color("#cbd5e1")
    
    ax.grid(axis="y", linestyle="-", color="#e2e8f0", linewidth=0.75)
    ax.tick_params(colors="#475569", labelsize=10)

    # 6. Build horizontal legend placed at the bottom center
    ax.legend(
        loc="upper center", 
        bbox_to_anchor=(0.5, -0.12),
        ncol=len(years), 
        frameon=False,
        fontsize=11
    )

    # 7. Save out high-res asset
    plt.savefig(OUTPUT_GRAPH, bbox_inches="tight", dpi=300)
    plt.close()
    print(f"YoY dashboard graph cleanly exported to: {OUTPUT_GRAPH}")

if __name__ == "__main__":
    generate_weekly_comparison_chart()