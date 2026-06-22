import requests
import pandas as pd
import os

AUTH_URL = "https://api.acaps.org/api/v1/token-auth/"
DATA_URL = "https://api.acaps.org/api/v1/ukraine/damages/"

def get_token():
    creds = {
        "username": os.environ["ACAPS_USERNAME"],
        "password": os.environ["ACAPS_PASSWORD"]
    }
    r = requests.post(AUTH_URL, json=creds)
    r.raise_for_status()
    return r.json()["token"]

def fetch_all_data(token):
    headers = {"Authorization": f"Token {token}"}
    url = DATA_URL
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
    df = fetch_all_data(token)

    os.makedirs("data", exist_ok=True)

    df.to_csv("data/acaps_ukraine_buildings.csv", index=False)

    weekly_oblast, weekly_matrix = summarise(df)

    weekly_oblast.to_csv("data/acaps_oblast_weekly.csv", index=False)
    weekly_matrix.to_csv("data/acaps_oblast_weekly_matrix.csv")

    print("Saved raw + weekly summaries")

if __name__ == "__main__":
    main()
