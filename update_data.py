import os
import pandas as pd
import requests

CSV_FILE = "ukraine_damages.csv"
API_URL = "https://api.acaps.org/api/v1/ukraine/damages/"

def fetch_and_update():
    print("Fetching data from ACAPS API...")
    
    # Adding a standard user-agent header avoids being blocked by API firewalls
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    try:
        response = requests.get(API_URL, headers=headers)
        response.raise_for_status()
    except Exception as e:
        print(f"Failed to fetch data from API: {e}")
        return
        
    api_data = response.json()
    print(f"API Response Type: {type(api_data)}")
    
    # Detect structure and normalize to a list of records
    if isinstance(api_data, dict):
        print(f"API Dictionary Keys found: {list(api_data.keys())}")
        if "results" in api_data:
            new_records = api_data["results"]
        elif "data" in api_data:
            new_records = api_data["data"]
        else:
            # Treat the single dictionary as a record or try to find a list value
            lists_inside = [v for v in api_data.values() if isinstance(v, list)]
            if lists_inside:
                new_records = lists_inside[0]  # Take the first array list found
            else:
                new_records = [api_data]
    elif isinstance(api_data, list):
        new_records = api_data
    else:
        print("Unknown JSON root structure format.")
        return

    # Guard check for empty arrays
    if not new_records:
        print("No records found in the parsed API response.")
        return

    df_new = pd.DataFrame(new_records)

    # Load existing data if file exists, else use the new data directly
    if os.path.exists(CSV_FILE) and os.path.getsize(CSV_FILE) > 0:
        df_existing = pd.read_csv(CSV_FILE)
        df_combined = pd.concat([df_existing, df_new]).drop_duplicates().reset_index(drop=True)
    else:
        print(f"{CSV_FILE} not found or empty. Initializing a new dataset.")
        df_combined = df_new

    # Save to CSV
    df_combined.to_csv(CSV_FILE, index=False)
    print(f"Successfully saved {len(df_combined)} rows to {CSV_FILE}.")

if __name__ == "__main__":
    fetch_and_update()