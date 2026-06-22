import requests
import pandas as pd
import os

AUTH_URL = "https://api.acaps.org/api/v1/token-auth/"
DATA_URL = "https://api.acaps.org/api/v1/ukraine/damages/"

START_DATE = "2026-05-01"
END_DATE = "2026-06-30"

print("Starting ACAPS fetch script...")
print("About to request token...")

def get_token():
    creds = {
        "username": os.environ["ACAPS_USERNAME"],
        "password": os.environ["ACAPS_PASSWORD"]
    }
    print("Requesting ACAPS token...")
    r = requests.post(AUTH_URL, json=creds, timeout=10)
    print("Token request completed")
    r.raise_for_status()
    return r.json()["token"]

def fetch_data_range(token, date_from, date_to):
    headers = {"Authorization": f"Token {token}"}
    url = f"{DATA_URL}?date__gte={date_from}&date__lte={date_to}"
    rows = []
    last_url = None

    print(f"Fetching ACAPS data from {date_from} to {date_to}")

    while url and url != last_url:
        print(f"Requesting: {url}")
        last_url = url

        r = requests.get(url, headers=headers, timeout=10)
        r.raise_for_status()
        data = r.json()

        rows.extend(data.get("results", []))
        url = data.get("next")

        if not url:
            break

    print(f"Fetched {len(rows)} records in range")
    return pd.DataFrame(rows)

def summarise(df):
    # ACAPS uses this field for event dates
    date_col = "date_of_event"

    if date_col not in df.columns:
        raise ValueError(f"'date_of_event' not found. Columns returned: {df.columns.tolist()}")

    print(f"Using date column: {date_col}")

    df["date"] = pd.to_datetime(df[date_col], errors="coerce")

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

    print("Refreshing May–June 2026 dataset")
    df = fetch_data_range(token, START_DATE, END_DATE)

    df.to_csv("data/acaps_ukraine_buildings.csv", index=False)

    weekly_oblast, weekly_matrix = summarise(df)
    weekly_oblast.to_csv("data/acaps_oblast_weekly.csv", index=False)
    weekly_matrix.to_csv("data/acaps_oblast_weekly_matrix.csv")

    print("Saved raw + weekly summaries")

if __name__ == "__main__":
    main()