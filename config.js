var config = {};
config.metrics = {};

// Credentials from GitHub Secrets environment variables
config.withingsClientID = process.env.WITHINGS_CLIENT_ID;
config.withingsClientSecret = process.env.WITHINGS_CLIENT_SECRET;
config.withingsState = "random_string_here";

// Google Drive Configuration
config.driveFolderId = "1rcyfE_q64FVBQce_FDmAseuayfDs_RzL"; 
config.driveFileName = "withings_data.csv";

// Pathing for GitHub Actions environment
config.data_dir = "./"; 
config.output_dir = config.data_dir + ".withings2gsheets/";
config.token_path = config.output_dir + "withings2gsheetstokens.json";
config.timestamp_path = config.output_dir + "withingsprevioustime.json";
config.gsheets_key_path = config.output_dir + "withings2gsheets-service-account.json";
config.sqlite3_output_path = config.data_dir + "withings_data.sqlite3";

// Final Metric Mapping (requested metrics only)
config.metrics = {
   "1": "Weight",
   "6": "Body Fat %",
   "11": "Heart Pulse",
   "91": "Pulse Wave Velocity (m/s)",       
   "130": "ECG",              
   "155": "Vascular Age",
   "158": "Nerve Health Score"
};

// Request only these specific IDs from Withings
config.metricList = "1,6,11,91,130,155,158";

module.exports = config;
