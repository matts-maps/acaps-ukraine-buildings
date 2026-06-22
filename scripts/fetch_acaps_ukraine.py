#!/usr/bin/env python3
import os
import sys
import time
import requests
import pandas as pd
from datetime import datetime, timedelta

ACAPS_TOKEN_URL = "https://api.acaps.org/api/v1/token/"
ACAPS_DATA_URL = "https://api.acaps.org/api/v1/ukraine/damages/"

START_DATE = "2026-05-01"
END_DATE   = "2026-06-30"


# ---------------------------------------------------------
# 1. Get ACAPS API token
# ---------------------------------------------------------
def get_token():
    print("Starting ACAPS fetch script...")
    print("About to request token...")
    username = os.getenv("ACAPS_USERNAME")
    password = os.getenv("ACAPS_PASSWORD")

    if not username or not password:
        print("ERROR: ACAPS_USERNAME or ACAPS_PASSWORD missing")
        sys.exit(1)

    print("Requesting ACAPS token...")
    r = requests.post(
        ACAPS_TOKEN_URL,
        data={"username": username, "password": password},
        timeout=20
    )
    print("Token request completed")

    if r.status_code != 200:
        print("Token request failed:", r.text)
        sys.exit(1)

    return r.json().get("token")


# ---------------------------------------------------------
# 2. Fetch all pages for a given date window
# ---------------------------------------------------------
def fetch_data_range(token, start_date, end_date):
    headers = {"Authorization": f"Token {token}"}
    page = 1
    all_rows = []

    while True:
        url = (
            f"{ACAPS_DATA_URL}"
            f"?date__gte={start_date}&date__lte={end_date}&page={page}"
        )

        print(f"Requesting: {url}")

        try:
            r = requests.get(url, headers=headers, timeout=20)
        except requests.exceptions.ReadTimeout:
            print(f"Timeout on page {page}, retrying once...")
            time.sleep(2)
            r = requests.get(url, headers=headers, timeout=20)

        if r.status_code != 200:
            print(f"Error {r.status_code}: {r.text}")
            break

        data = r.json()
        results = data.get("results", [])

        if not results:
            break

        all_rows.extend(results)

        if not data.get("next"):
            break

        page += 1
        time.sleep(0.3)  # gentle pacing

    return pd.DataFrame(all_rows)


# ---------------------------------------------------------
# 3. Weekly window generator
# ---------------------------------------------------------
def weekly_windows(start, end):
    cur = start
    while cur < end:
        nxt = min(cur + timedelta(days=7), end)
        yield cur, nxt
        cur = nxt


# ---------------------------------------------------------
# 4. Summaries
# ---------------------------------------------------------
def summarise(df):
    if df.empty:
        return pd.DataFrame(), pd.DataFrame()

    df["date"] = pd.to_datetime(df["date"])
    df["week"] = df["date"].dt.to_period("W").astype(str)

    weekly_oblast = (
        df.groupby(["week", "oblast"])
          .size()
          .reset_index(name="count")
    )

    weekly_matrix = (
        weekly_oblast.pivot(index="week", columns="oblast", values="count")
                     .fillna(0)
                     .astype(int)
    )

    return weekly_oblast, weekly_matrix


# ---------------------------------------------------------
# 5. Main
# ---------------------------------------------------------
def main():
    token = get_token()
    os.makedirs("data", exist_ok=True)

    print("Refreshing May–June 2026 dataset (weekly windows)")

    start = datetime.strptime(START_DATE, "%Y-%m-%d")
    end   = datetime.strptime(END_DATE, "%Y-%m-%d")

    frames = []

    for a, b in weekly_windows(start, end):
        a_str = a.strftime("%Y-%m-%d")
        b_str = b.strftime("%Y-%m-%d")

        print(f"\n=== Fetching window {a_str} → {b_str} ===")
        df = fetch_data_range(token, a_str, b_str)
        frames.append(df)

    df_all = pd.concat(frames, ignore_index=True)
    df_all.to_csv("data/acaps_ukraine_buildings.csv", index=False)

    weekly_oblast, weekly_matrix = summarise(df_all)
    weekly_oblast.to_csv("data/acaps_oblast_weekly.csv", index=False)
    weekly_matrix.to_csv("data/acaps_oblast_weekly_matrix.csv")

    print("\nSaved raw + weekly summaries")
    print("Done.")


# ---------------------------------------------------------
if __name__ == "__main__":
    main()
