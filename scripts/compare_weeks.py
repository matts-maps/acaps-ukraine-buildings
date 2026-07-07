import os
import pandas as pd
import matplotlib
matplotlib.use('Agg')  # Required for headless/GitHub Action environments
import matplotlib.pyplot as plt

INPUT_FILE = "data/ukraine-damages.csv"
OUTPUT_GRAPH = "data/week_4_comparison.png"
OUTPUT_CSV = "data/week_4_comparison.csv"
TARGET_WEEK = 4

def generate_weekly_comparison():
    if not os.path.exists(INPUT_FILE):
        print(f"Error: '{INPUT_FILE}' not found. Please run the update script first.")
        return

    print(f"Reading data from {INPUT_FILE}...")
    df = pd.read_csv(INPUT_FILE)
    
    if df.empty:
        print("Dataset is empty. Skipping analysis.")
        return

    # Convert to datetime and drop missing rows
    df["date_of_event"] = pd.to_datetime(df["date_of_event"], errors="coerce")
    df = df.dropna(subset=["date_of_event"])

    # Extract ISO standard Year and Week numbers
    df["iso_year"] = df["date_of_event"].dt.isocalendar().year
    df["iso_week"] = df["date_of_event"].dt.isocalendar().week

    # Filter specifically for Week 4 across all years
    df_week = df[df["iso_week"] == TARGET_WEEK]

    if df_week.empty:
        print(f"No records found matching ISO Week {TARGET_WEEK}.")
        return

    # Aggregate damage counts (1 row = 1 recorded damage event)
    comparison_df = (
        df_week.groupby("iso_year")
        .size()
        .reset_index(name="total_damaged_buildings")
    )
    comparison_df = comparison_df.sort_values("iso_year")

    # --- 1. GENERATE AND PRINT TABLE ---
    print("\n" + "="*45)
    print(f"  WEEK {TARGET_WEEK} HISTORICAL COMPARISON SUMMARY")
    print("="*45)
    # Formats numbers with thousands separator for terminal legibility
    print(comparison_df.to_string(
        index=False, 
        formatters={"iso_year": str, "total_damaged_buildings": "{:,}".format}
    ))
    print("="*45 + "\n")

    # Save summary table as a lightweight CSV backup
    comparison_df.to_csv(OUTPUT_CSV, index=False)

    # --- 2. GENERATE AND SAVE GRAPH ---
    print("Generating historical chart...")
    plt.figure(figsize=(9, 5.5))
    
    # Render custom bar chart
    bars = plt.bar(
        comparison_df["iso_year"].astype(str), 
        comparison_df["total_damaged_buildings"], 
        color="#3498db", 
        edgecolor="#2980b9",
        width=0.5
    )

    # Inject numeric text tags strictly above each vertical bar
    for bar in bars:
        height = bar.get_height()
        plt.text(
            bar.get_x() + bar.get_width()/2.0, 
            height + (height * 0.01), 
            f"{int(height):,}", 
            ha="center", 
            va="bottom", 
            fontweight="bold",
            color="#2c3e50"
        )

    plt.title(f"Total Recorded Building Damages During Week {TARGET_WEEK} by Year", fontsize=13, fontweight="bold", pad=15)
    plt.xlabel("Year", fontsize=11, labelpad=10)
    plt.ylabel("Damaged Buildings Count", fontsize=11, labelpad=10)
    plt.grid(axis="y", linestyle="--", alpha=0.5)
    
    # Clean visual layout and export
    os.makedirs(os.path.dirname(OUTPUT_GRAPH), exist_ok=True)
    plt.savefig(OUTPUT_GRAPH, bbox_inches="tight", dpi=300)
    plt.close()

    print(f"Graph safely exported to: {OUTPUT_GRAPH}")

if __name__ == "__main__":
    generate_weekly_comparison()