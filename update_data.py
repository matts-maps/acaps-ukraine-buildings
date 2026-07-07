import os
import pandas as pd
import requests

CSV_FILE = "ukraine_damages.csv"
API_URL = "https://api.acaps.org/api/v1/ukraine/damages/"

def fetch_and_update():
    print("Fetching data from ACAPS API...")
    try:
        response = requests.get(API_URL)
        response.raise_for_status()
    except Exception as e:
        print(f"Failed to fetch data from API: {e}")
        return
        
    api_data = response.json()
    
    # Handle different possible API response structures
    if isinstance(api_data, dict) and "results" in api_data:
        new_records = api_data["results"]
    elif isinstance(api_data, list):
        new_records = api_data
    elif isinstance(api_data, dict):
        # If it's a single dictionary object wrapped in an API response
        new_records = [api_data]
    else:
        print("Unexpected API structure received.")
        return

    df_new = pd.DataFrame(new_records)

    # Load existing data if file exists, else use the new data directly
    if os.path.exists(CSV_FILE) and os.path.getsize(CSV_FILE) > 0:
        df_existing = pd.read_csv(CSV_FILE)
        df_combined = pd.concat([df_existing, df_new]).drop_duplicates().reset_index(drop=True)
    else:
        print(f"{CSV_FILE} not found or empty. Creating a new one.")
        df_combined = df_new

    # Save to CSV
    df_combined.to_csv(CSV_FILE, index=False)
    print(f"Successfully saved data to {CSV_FILE}.")

if __name__ == "__main__":
    fetch_and_update()