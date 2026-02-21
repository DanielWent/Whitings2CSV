var config = {};
config.metrics = {};

config.withingsClientID = process.env.WITHINGS_CLIENT_ID;
config.withingsClientSecret = process.env.WITHINGS_CLIENT_SECRET;
config.withingsState = "random_string_here";

config.driveFolderId = "1rcyfE_q64FVBQce_FDmAseuayfDs_RzL"; 

config.data_dir = "./"; 
config.output_dir = config.data_dir + ".withings2gsheets/";

// Common settings
config.gsheets_key_path = config.output_dir + "withings2gsheets-service-account.json";

// Define Users
config.users = [
    {
        id: "drw", // Daniel
        height: 1.85,
        token_path: config.output_dir + "drw_tokens.json",
        timestamp_path: config.output_dir + "drw_last_sync.json",
        driveFileName: "drw_whitings_scale_data.csv",
        // Metric Type IDs for Withings Body Scan
        metricList: "1,6,91,130,155,158,170" 
    },
    {
        id: "aflw", // April
        height: 1.65, // Adjust height as necessary
        token_path: config.output_dir + "aflw_tokens.json",
        timestamp_path: config.output_dir + "aflw_last_sync.json",
        driveFileName: "aflw_whitings_scale_data.csv",
        // Assuming same metrics, but can be changed per user
        metricList: "1,6,91,130,155,158,170"
    }
];

config.metrics = {
    "1": "Weight (kg)",
    "6": "Body Fat (%)",
    "91": "Pulse Wave Velocity (m/s)",
    "130": "AFib Status",
    "155": "Vascular Age (years)",
    "158": "Nerve Health Score",
    "170": "Visceral Fat Rating" 
};

module.exports = config;
