import os
import pandas as pd

INPUT_FILE = "data/ukraine-damages.csv"
OUTPUT_FILE = "data/ukraine-damages-weekly-summary.csv"

def summarize_data():
    if not os.path.exists(INPUT_FILE):
        print(f"Error: '{INPUT_FILE}' does not exist. Please run your update script first.")
        return

    print(f"Loading data from {INPUT_FILE}...")
    df = pd.read_csv(INPUT_FILE)

    if df.empty:
        print("The dataset is empty. Nothing to summarize.")
        return

    # 1. Validate and convert the date column
    if "date_of_event" not in df.columns:
        print("Error: 'date_of_event' column not found in the dataset.")
        return
    
    df["date_of_event"] = pd.to_datetime(df["date_of_event"], errors="coerce")

    # 2. Dynamically identify the Oblast/Region column name
    # ACAPS/HDX payloads often flip between 'oblast', 'admin1', or 'admin1_name'
    oblast_col = None
    possible_names = ["oblast", "oblast_name", "admin1", "admin1_name", "region"]
    
    for col in df.columns:
        if col.lower() in possible_names:
            oblast_col = col
            break
            
    if not oblast_col:
        # Fallback search if names don't match exactly
        fallback_cols = [col for col in df.columns if "admin1" in col.lower() or "oblast" in col.lower()]
        oblast_col = fallback_cols[0] if fallback_cols else "oblast"

    if oblast_col not in df.columns:
        print(f"Error: Could not identify an Oblast column. Available columns: {list(df.columns)}")
        return

    # Drop rows missing crucial aggregation elements
    df = df.dropna(subset=["date_of_event", oblast_col])

    print(f"Aggregating damages by week using region column: '{oblast_col}'...")

    # 3. Group by Oblast and Week (freq='W' aggregates weeks ending on Sunday)
    # Note: .size() counts the rows assuming 1 row = 1 damage incident.
    # If the API provides an explicit count column (e.g., 'count'), swap .size() for .sum()
    weekly_summary = (
        df.groupby([oblast_col, pd.Grouper(key="date_of_event", freq="W")])
        .size()
        .reset_index(name="total_damaged_buildings")
    )

    # Format the date column to a clean string format (YYYY-MM-DD)
    weekly_summary["week_ending"] = weekly_summary["date_of_event"].dt.strftime("%Y-%m-%d")
    
    # Restructure columns and sort (latest weeks first, then alphabetical by Oblast)
    weekly_summary = weekly_summary[[oblast_col, "week_ending", "total_damaged_buildings"]]
    weekly_summary = weekly_summary.sort_values(
        by=["week_ending", oblast_col], 
        ascending=[False, True]
    )

    # Ensure output directory exists and save
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    weekly_summary.to_csv(OUTPUT_FILE, index=False)
    
    print(f"Successfully saved summary to {OUTPUT_FILE} ({len(weekly_summary)} rows generated).")

if __name__ == "__main__":
    summarize_data()