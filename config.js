var config = {};
config.metrics = {};

config.withingsClientID = "YOUR_WITHINGS_CLIENT_ID"
config.withingsClientSecret = "YOUR_WITHINGS_CLIENT_SECRET"
config.withingsState = "random_string_here"
config.gSheetsId = "YOUR_GSHEET_ID"
config.gSheetsTabId = "YOUR_GSHEET_TAB_ID"
config.useConorsTabs = false 
config.conorsAnnualTabId = "9999999999" 

config.height = 1.7526 // Your height in metres

// If any repeated token issues connecting to Withings, you should manually delete withings2gsheetstokens.json in .withings2gsheets and re-run
config.data_dir = "./" 
config.output_dir = config.data_dir + ".withings2gsheets/";
config.token_path = config.output_dir + "withings2gsheetstokens.json";
config.timestamp_path = config.output_dir + "withingsprevioustime.json";

// This is the file you got from Google when you setup access to GSheets. 
config.gsheets_key_path = config.output_dir + "withings2gsheets-service-account.json";

// Local paths (still used for temp storage or local runs)
config.csv_output_path = config.data_dir + "withings_data.csv";
config.sqlite3_output_path = config.data_dir + "withings_data.sqlite3";

// Google Drive Configuration (NEW)
config.driveFolderId = "PASTE_YOUR_DRIVE_FOLDER_ID_HERE"; 
config.driveFileName = "withings_data.csv";

config.metrics = {
   "1": "Weight",
   "5": "Fat Free Mass",
   "6": "Fat Ratio",
   "8": "Fat Mass Weight",
   "11": "Heart Pulse",
   "76": "Muscle Mass",
   "77": "Hydration",
   "88": "Bone Mass",
   "91": "Pulse Wave Velocity"
}

config.metricList = "1,5,6,8,11,76,77,88,91"

// Ignore if you aren't Conor :-) Columns by index
config.metricsConor = {
   "Weight lbs": 7,
   "Weight": 8,
   "Weight KG": 9,
   "Body Fat": 10,
   "Water": 11,
   "BMI": 12,
   "Muscle": 13
}

module.exports = config;
