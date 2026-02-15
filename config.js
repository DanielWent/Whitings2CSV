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

// Removed Heart Rate (11)
config.metrics = {
   "1": "Weight (kg)",
   "6": "Body Fat (%)",
   "91": "Pulse Wave Velocity (m/s)",       
   "130": "AFib Status",
   "155": "Vascular Age (years)",
   "158": "Nerve Health Score"
};

// Removed 11 from request string
config.metricList = "1,6,91,130,155,158";

module.exports = config;
