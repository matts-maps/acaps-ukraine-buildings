import os
import pandas as pd
import requests

CSV_FILE = "ukraine_damages.csv"
API_URL = "https://api.acaps.org/api/v1/ukraine/damages/"

def fetch_and_update():
    print("Fetching data from ACAPS API...")
    
    # Grab the hidden token from the environment
    api_token = os.environ.get("ACAPS_TOKEN")
    
    if api_token:
        print(f"Token found in environment. Length: {len(api_token)} characters.")
    else:
        print("WARNING: ACAPS_TOKEN environment variable is completely empty or missing.")

    if not api_token:
        raise ValueError("API Token missing! Make sure ACAPS_API_TOKEN is set in GitHub Secrets.")

    # Try standard Django Token header format first
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Authorization": f"Token {api_token}" 
    }
    
    response = requests.get(API_URL, headers=headers)
    
    # If standard Token fails with 401, try the alternate Bearer format automatically
    if response.status_code == 401:
        print("Standard token auth failed (401). Retrying with Bearer authentication...")
        headers["Authorization"] = f"Bearer {api_token}"
        response = requests.get(API_URL, headers=headers)
        
    response.raise_for_status() 
        
    api_data = response.json()
    print(f"Successfully retrieved JSON data. Data type: {type(api_data)}")
    
    if isinstance(api_data, dict):
        if "results" in api_data:
            new_records = api_data["results"]
        elif "data" in api_data:
            new_records = api_data["data"]
        else:
            new_records = [api_data]
    elif isinstance(api_data, list):
        new_records = api_data
    else:
        raise ValueError(f"Unknown JSON root structure format: {type(api_data)}")

    if not new_records:
        raise ValueError("The API returned an empty dataset or list.")

    df_new = pd.DataFrame(new_records)

    if os.path.exists(CSV_FILE) and os.path.getsize(CSV_FILE) > 0:
        df_existing = pd.read_csv(CSV_FILE)
        df_combined = pd.concat([df_existing, df_new]).drop_duplicates().reset_index(drop=True)
    else:
        print(f"Initializing brand new dataset for {CSV_FILE}.")
        df_combined = df_new

    df_combined.to_csv(CSV_FILE, index=False)
    print(f"Successfully saved {len(df_combined)} rows to {CSV_FILE}.")

if __name__ == "__main__":
    fetch_and_update()