import os
import time
import requests
import pandas as pd

API_URL = "https://api.acaps.org/api/v1/ukraine/damages/"
CSV_FILE = "data/ukraine-damages.csv"

TOKEN = os.environ["ACAPS_API_TOKEN"]

HEADERS = {
    "Authorization": f"Token {TOKEN}"
}

def fetch_all_records():
    records = []
    next_url = API_URL

    while next_url:
        print(f"Fetching: {next_url}")

        response = requests.get(
            next_url,
            headers=HEADERS,
            timeout=60
        )

        response.raise_for_status()

        payload = response.json()

        if isinstance(payload, list):
            records.extend(payload)
            next_url = None

        elif isinstance(payload, dict):
            if "results" in payload:
                records.extend(payload["results"])
                next_url = payload.get("next")

            elif "data" in payload:
                records.extend(payload["data"])
                next_url = payload.get("next")

            else:
                records.extend([payload])
                next_url = None

        else:
            raise Exception("Unexpected API response structure")

        time.sleep(1)

    print(f"Downloaded {len(records)} records")
    return records


def main():
    api_records = fetch_all_records()

    api_df = pd.DataFrame(api_records)

    if api_df.empty:
        raise Exception("No records returned from API")

    if os.path.exists(CSV_FILE):
        current_df = pd.read_csv(CSV_FILE, dtype=str)
    else:
        current_df = pd.DataFrame()

    api_df = api_df.astype(str)

    if "damage_id" not in api_df.columns:
        raise Exception(
            "damage_id not found in API response"
        )

    if current_df.empty:
        merged_df = api_df
    else:
        current_df = current_df.astype(str)

        merged_df = pd.concat(
            [current_df, api_df],
            ignore_index=True
        )

        merged_df = merged_df.drop_duplicates(
            subset=["damage_id"],
            keep="last"
        )

    if "date_of_event" in merged_df.columns:
        merged_df["date_of_event"] = pd.to_datetime(
            merged_df["date_of_event"],
            errors="coerce"
        )

        merged_df = merged_df.sort_values(
            "date_of_event",
            ascending=False
        )

    merged_df.to_csv(
        CSV_FILE,
        index=False
    )

    print(
        f"Saved {len(merged_df)} records to {CSV_FILE}"
    )


if __name__ == "__main__":
    main()