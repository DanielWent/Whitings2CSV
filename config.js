var config = {};
config.metrics = {};

// Read from Environment Variables for security
config.withingsClientID = process.env.WITHINGS_CLIENT_ID;
config.withingsClientSecret = process.env.WITHINGS_CLIENT_SECRET;

config.withingsState = "random_string_here" 

// Google Drive Configuration
config.driveFolderId = "1rcyfE_q64FVBQce_FDmAseuayfDs_RzL"; 
config.driveFileName = "withings_data.csv";

config.height = 1.7526 

config.data_dir = "./" 
config.output_dir = config.data_dir + ".withings2gsheets/";
config.token_path = config.output_dir + "withings2gsheetstokens.json";
config.timestamp_path = config.output_dir + "withingsprevioustime.json";

// This is the file you got from Google when you setup access to Drive. 
config.gsheets_key_path = config.output_dir + "withings2gsheets-service-account.json";

// Local paths (still used for temp storage or local runs)
config.csv_output_path = config.data_dir + "withings_data.csv";
config.sqlite3_output_path = config.data_dir + "withings_data.sqlite3";

// Updated Metrics Map
config.metrics = {
   "1": "Weight",
   "5": "Fat Free Mass",
   "6": "Fat Ratio",
   "8": "Fat Mass Weight",
   "11": "Heart Pulse",
   "76": "Muscle Mass",
   "77": "Hydration",
   "88": "Bone Mass",
   "91": "Vascular Age",       
   "130": "ECG",              
   "158": "Nerve Health Score"
}

// Updated list to include 91, 130, 158
config.metricList = "1,5,6,8,11,76,77,88,91,130,158"

// Columns by index
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
