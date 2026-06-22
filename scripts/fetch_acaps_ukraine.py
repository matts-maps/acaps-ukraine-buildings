import requests
import pandas as pd
import os
from datetime import datetime

AUTH_URL = "https://api.acaps.org/api/v1/token-auth/"
DATA_URL = "https://api.acaps.org/api/v1/ukraine/damages/"

START_DATE = "2025-01-01"

def get_token():
    creds = {
        "username": os.environ["ACAPS_USERNAME"],
        "password": os.environ["ACAPS_PASSWORD"]
    }
    r = requests.post(AUTH_URL, json=creds)
    r.raise_for_status()
    return r.json()["token"]

def fetch_data_since(token, date_from):
    headers = {"Authorization": f"Token {token}"}
    url = f"{DATA_URL}?date__gte={date_from}"
    rows = []

    while url:
        r = requests.get(url, headers=headers)
        r.raise_for_status()
        data = r.json()
        rows.extend(data["results"])
        url = data.get("next")

    return pd.DataFrame(rows)

def summarise(df):
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["iso_year"] = df["date"].dt.isocalendar().year
    df["iso_week"] = df["date"].dt.isocalendar().week

    weekly_oblast = (
        df.groupby(["oblast", "iso_year", "iso_week"])
          .size()
          .reset_index(name="damaged_buildings")
    )

    weekly_matrix = weekly_oblast.pivot_table(
        index="oblast",
        columns=["iso_year", "iso_week"],
        values="damaged_buildings",
        fill_value=0
    )

    return weekly_oblast, weekly_matrix

def main():
    token = get_token()
    os.makedirs("data", exist_ok=True)

    csv_path = "data/acaps_ukraine_buildings.csv"

    if os.path.exists(csv_path):
        # Incremental update
        existing = pd.read_csv(csv_path)
        existing["date"] = pd.to_datetime(existing["date"], errors="coerce")
        last_date = existing["date"].max().strftime("%Y-%m-%d")

        print(f"Existing data found. Last date = {last_date}")
        new_df = fetch_data_since(token, last_date)

        if len(new_df) > 0:
            print(f"Fetched {len(new_df)} new records")
            df = pd.concat([existing, new_df], ignore_index=True)
        else:
            print("No new data available")
            df = existing

    else:
        # First run: full fetch from 2025-01-01
        print("No existing data found. Fetching full dataset from 2025-01-01")
        df = fetch_data_since(token, START_DATE)

    # Save raw
    df.to_csv(csv_path, index=False)

    # Summaries
    weekly_oblast, weekly_matrix = summarise(df)
    weekly_oblast.to_csv("data/acaps_oblast_weekly.csv", index=False)
    weekly_matrix.to_csv("data/acaps_oblast_weekly_matrix.csv")

    print("Saved raw + weekly summaries")

if __name__ == "__main__":
    main()
