var config = {};
config.metrics = {};

config.withingsClientID = process.env.WITHINGS_CLIENT_ID;
config.withingsClientSecret = process.env.WITHINGS_CLIENT_SECRET;
config.withingsState = "random_string_here";

config.driveFolderId = "1rcyfE_q64FVBQce_FDmAseuayfDs_RzL"; 
config.driveFileName = "withings_data.csv";

config.data_dir = "./"; 
config.output_dir = config.data_dir + ".withings2gsheets/";
config.token_path = config.output_dir + "withings2gsheetstokens.json";
config.timestamp_path = config.output_dir + "withingsprevioustime.json";

config.gsheets_key_path = config.output_dir + "withings2gsheets-service-account.json";
config.sqlite3_output_path = config.output_dir + "withings_data.db";
config.csv_output_path = config.data_dir + "withings_data.csv";

// Your Height in Meters
config.height = 1.85; 

// Metric Type IDs to Name mapping
config.metrics = {
    "1": "Weight (kg)",
    "4": "Height (meter)",
    "5": "Fat Free Mass (kg)",
    "6": "Body Fat (%)",
    "8": "Fat Mass Weight (kg)",
    "9": "Diastolic Blood Pressure (mmHg)",
    "10": "Systolic Blood Pressure (mmHg)",
    "11": "Heart Pulse (bpm)",
    "125": "Visceral Fat Rating", // Updated to correct Body Scan ID
    "54": "SP02 (%)",
    "71": "Body Temperature (celsius)",
    "73": "Skin Temperature (celsius)",
    "76": "Muscle Mass (kg)",
    "77": "Hydration (kg)",
    "88": "Bone Mass (kg)",
    "91": "Pulse Wave Velocity (m/s)",
    "123": "VO2 max",
    "130": "AFib Status",
    "155": "Vascular Age (years)",
    "158": "Nerve Health Score"
};

// Request string (including 125)
config.metricList = "1,4,5,6,8,9,10,11,54,71,73,76,77,88,91,123,125,130,155,158";

module.exports = config;
